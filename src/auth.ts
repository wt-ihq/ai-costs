import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

/**
 * Full server-side Auth.js instance (handlers, session, sign-in/out).
 * The Edge-safe provider/callback config lives in auth.config.ts so the
 * middleware can share it without bundling server-only modules.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
