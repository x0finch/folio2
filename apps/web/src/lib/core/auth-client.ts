import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";

// UX only (sign-in, session reads); the data security boundary is each authed server fn.
export const authClient = createAuthClient({ plugins: [passkeyClient()] });

export const { signIn, signUp, signOut } = authClient;
