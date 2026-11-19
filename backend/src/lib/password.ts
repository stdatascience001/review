import { hash, verify, Algorithm } from '@node-rs/argon2';

// OWASP-recommended Argon2id parameters (19 MiB memory, 2 iterations, 1 lane).
const OPTIONS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string): Promise<string> => hash(password, OPTIONS);

export const verifyPassword = async (passwordHash: string, password: string): Promise<boolean> => {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
};

// Used to keep login timing roughly constant when the account does not exist,
// so response time does not reveal which emails are registered.
let dummyHash: Promise<string> | undefined;
export const verifyDummyPassword = async (password: string): Promise<void> => {
  dummyHash ??= hashPassword('dummy-password-for-timing-equalisation');
  await verifyPassword(await dummyHash, password);
};
