import type { AuthConfig } from "convex/server";
export default {
  providers: [
    {
      type: "customJwt",
      applicationID: process.env.PRIVY_APP_ID,
      issuer: "privy.io",
      jwks: `https://auth.privy.io/api/v1/apps/${process.env.PRIVY_APP_ID}/jwks.json`,
      algorithm: "ES256",
    },
  ],
} satisfies AuthConfig;
