import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import Backend from "./apps/api/src/worker.ts";

const clerkPublishableKey = process.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!clerkPublishableKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");
}

export default Alchemy.Stack(
  "Mossboard",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const backend = yield* Backend;
    const website = yield* Cloudflare.Website.Vite("Website", {
      rootDir: "./apps/web",
      env: {
        VITE_API_URL: backend.url.as<string>(),
        VITE_CLERK_PUBLISHABLE_KEY: clerkPublishableKey,
      },
      assets: {
        notFoundHandling: "single-page-application",
      },
      dev: {
        port: 5173,
      },
    });

    return {
      backendUrl: backend.url.as<string>(),
      websiteUrl: website.url.as<string>(),
    };
  }),
);
