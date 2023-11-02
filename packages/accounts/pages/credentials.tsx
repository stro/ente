import { useEffect, useState } from 'react';

import { t } from 'i18next';

import {
    clearData,
    getData,
    LS_KEYS,
    setData,
} from '@ente/shared/storage/localStorage';
import { PAGES } from '../constants/pages';
import {
    SESSION_KEYS,
    getKey,
    removeKey,
    setKey,
} from '@ente/shared/storage/sessionStorage';
import {
    decryptAndStoreToken,
    generateAndSaveIntermediateKeyAttributes,
    generateLoginSubKey,
    saveKeyInSessionStore,
} from '@ente/shared/crypto/helpers';
import { generateSRPSetupAttributes } from '../services/srp';
import { logoutUser } from '../services/user';

import { configureSRP, loginViaSRP } from '../services/srp';
import { getSRPAttributes } from '../api/srp';
import { SRPAttributes } from '../types/srp';

import {
    isFirstLogin,
    setIsFirstLogin,
} from '@ente/shared/storage/localStorage/helpers';
import { KeyAttributes, User } from '@ente/shared/user/types';
import FormPaper from '@ente/shared/components/Form/FormPaper';
import FormPaperTitle from '@ente/shared/components/Form/FormPaper/Title';
import FormPaperFooter from '@ente/shared/components/Form/FormPaper/Footer';
import LinkButton from '@ente/shared/components/LinkButton';
// import isElectron from 'is-electron';
// import safeStorageService from 'services/electron/safeStorage';
import { VerticallyCentered } from '@ente/shared/components/Container';
import EnteSpinner from '@ente/shared/components/EnteSpinner';
import VerifyMasterPasswordForm, {
    VerifyMasterPasswordFormProps,
} from '@ente/shared/components/VerifyMasterPasswordForm';
// import { APPS, getAppName } from '@ente/shared/apps';
import { addLocalLog } from '@ente/shared/logging';
import ComlinkCryptoWorker from '@ente/shared/crypto';
import { B64EncryptionResult } from '@ente/shared/crypto/types';
import { CustomError } from '@ente/shared/error';
import InMemoryStore, { MS_KEYS } from '@ente/shared/storage/InMemoryStore';
import { PageProps } from '@ente/shared/apps/types';
import { APPS } from '@ente/shared/apps/constants';
import { logError } from '@ente/shared/sentry';

export default function Credentials({
    appContext,
    router,
    appName,
}: PageProps) {
    const [srpAttributes, setSrpAttributes] = useState<SRPAttributes>();
    const [keyAttributes, setKeyAttributes] = useState<KeyAttributes>();
    const [user, setUser] = useState<User>();

    useEffect(() => {
        if (appName === APPS.AUTH) {
            router.prefetch(PAGES.AUTH);
        } else if (appName === APPS.PHOTOS) {
            router.prefetch(PAGES.GALLERY);
        } else {
            router.prefetch(PAGES.SHARED_ALBUMS);
        }
        const main = async () => {
            const user: User = getData(LS_KEYS.USER);
            if (!user?.email) {
                router.push(PAGES.ROOT);
                return;
            }
            setUser(user);
            const key = getKey(SESSION_KEYS.ENCRYPTION_KEY);
            // if (!key && isElectron()) {
            //     key = await safeStorageService.getEncryptionKey();
            //     if (key) {
            //         await saveKeyInSessionStore(
            //             SESSION_KEYS.ENCRYPTION_KEY,
            //             key,
            //             true
            //         );
            //     }
            // }
            if (key) {
                router.push(PAGES.GALLERY);
                return;
            }
            const kekEncryptedAttributes: B64EncryptionResult = getKey(
                SESSION_KEYS.KEY_ENCRYPTION_KEY
            );
            const keyAttributes: KeyAttributes = getData(
                LS_KEYS.KEY_ATTRIBUTES
            );
            if (kekEncryptedAttributes && keyAttributes) {
                removeKey(SESSION_KEYS.KEY_ENCRYPTION_KEY);
                const cryptoWorker = await ComlinkCryptoWorker.getInstance();
                const kek = await cryptoWorker.decryptB64(
                    kekEncryptedAttributes.encryptedData,
                    kekEncryptedAttributes.nonce,
                    kekEncryptedAttributes.key
                );
                const key = await cryptoWorker.decryptB64(
                    keyAttributes.encryptedKey,
                    keyAttributes.keyDecryptionNonce,
                    kek
                );
                useMasterPassword(key, kek, keyAttributes);
                return;
            }
            if (keyAttributes) {
                if (
                    (!user?.token && !user?.encryptedToken) ||
                    (keyAttributes && !keyAttributes.memLimit)
                ) {
                    clearData();
                    router.push(PAGES.ROOT);
                    return;
                }
                setKeyAttributes(keyAttributes);
                return;
            }

            const srpAttributes: SRPAttributes = getData(
                LS_KEYS.SRP_ATTRIBUTES
            );
            if (srpAttributes) {
                setSrpAttributes(srpAttributes);
            } else {
                router.push(PAGES.ROOT);
            }
        };
        main();
        appContext.showNavBar(true);
    }, []);

    const getKeyAttributes: VerifyMasterPasswordFormProps['getKeyAttributes'] =
        async (kek: string) => {
            try {
                if (!srpAttributes) {
                    throw Error('SRP attributes are missing');
                }
                const cryptoWorker = await ComlinkCryptoWorker.getInstance();
                const response = await loginViaSRP(srpAttributes, kek);
                if (response.twoFactorSessionID) {
                    const { twoFactorSessionID } = response;
                    const sessionKeyAttributes =
                        await cryptoWorker.generateKeyAndEncryptToB64(kek);
                    setKey(
                        SESSION_KEYS.KEY_ENCRYPTION_KEY,
                        sessionKeyAttributes
                    );
                    const user = getData(LS_KEYS.USER);
                    setData(LS_KEYS.USER, {
                        ...user,
                        twoFactorSessionID,
                        isTwoFactorEnabled: true,
                    });
                    setIsFirstLogin(true);
                    router.push(PAGES.TWO_FACTOR_VERIFY);
                    throw Error(CustomError.TWO_FACTOR_ENABLED);
                } else {
                    const { token, encryptedToken, id, keyAttributes } =
                        response;
                    const user = getData(LS_KEYS.USER);
                    setData(LS_KEYS.USER, {
                        ...user,
                        token,
                        encryptedToken,
                        id,
                        isTwoFactorEnabled: false,
                    });
                    if (keyAttributes) {
                        setData(LS_KEYS.KEY_ATTRIBUTES, keyAttributes);
                    }
                    return keyAttributes;
                }
            } catch (e) {
                if (
                    e instanceof Error &&
                    e.message !== CustomError.TWO_FACTOR_ENABLED
                ) {
                    logError(e, 'getKeyAttributes failed');
                }
                throw e;
            }
        };

    const useMasterPassword: VerifyMasterPasswordFormProps['callback'] = async (
        key,
        kek,
        keyAttributes,
        passphrase
    ) => {
        try {
            if (isFirstLogin() && passphrase) {
                await generateAndSaveIntermediateKeyAttributes(
                    passphrase,
                    keyAttributes,
                    key
                );
            }
            await saveKeyInSessionStore(SESSION_KEYS.ENCRYPTION_KEY, key);
            await decryptAndStoreToken(keyAttributes, key);
            try {
                let srpAttributes: SRPAttributes = getData(
                    LS_KEYS.SRP_ATTRIBUTES
                );
                if (!srpAttributes) {
                    srpAttributes = await getSRPAttributes(user.email);
                    if (srpAttributes) {
                        setData(LS_KEYS.SRP_ATTRIBUTES, srpAttributes);
                    }
                }
                addLocalLog(() => `userSRPSetupPending ${!srpAttributes}`);
                if (!srpAttributes) {
                    const loginSubKey = await generateLoginSubKey(kek);
                    const srpSetupAttributes = await generateSRPSetupAttributes(
                        loginSubKey
                    );
                    await configureSRP(srpSetupAttributes);
                }
            } catch (e) {
                logError(e, 'migrate to srp failed');
            }
            const redirectURL = InMemoryStore.get(MS_KEYS.REDIRECT_URL);
            InMemoryStore.delete(MS_KEYS.REDIRECT_URL);
            if (appName === APPS.AUTH) {
                router.push(PAGES.AUTH);
            } else {
                router.push(redirectURL ?? PAGES.GALLERY);
            }
        } catch (e) {
            logError(e, 'useMasterPassword failed');
        }
    };

    const redirectToRecoverPage = () => router.push(PAGES.RECOVER);

    if (!keyAttributes && !srpAttributes) {
        return (
            <VerticallyCentered>
                <EnteSpinner />
            </VerticallyCentered>
        );
    }

    const logoutHandler = () => {
        logoutUser(router);
    };

    return (
        <VerticallyCentered>
            <FormPaper style={{ minWidth: '320px' }}>
                <FormPaperTitle>{t('PASSWORD')}</FormPaperTitle>

                <VerifyMasterPasswordForm
                    buttonText={t('VERIFY_PASSPHRASE')}
                    callback={useMasterPassword}
                    user={user}
                    keyAttributes={keyAttributes}
                    getKeyAttributes={getKeyAttributes}
                    srpAttributes={srpAttributes}
                />
                <FormPaperFooter style={{ justifyContent: 'space-between' }}>
                    <LinkButton onClick={redirectToRecoverPage}>
                        {t('FORGOT_PASSWORD')}
                    </LinkButton>
                    <LinkButton onClick={logoutHandler}>
                        {t('CHANGE_EMAIL')}
                    </LinkButton>
                </FormPaperFooter>
            </FormPaper>
        </VerticallyCentered>
    );
}
