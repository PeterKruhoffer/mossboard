import { createClerkClient } from "@clerk/backend";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { AiGateway } from "./ai.ts";
import { authenticateSession } from "./auth.ts";

export const Database = Cloudflare.D1.Database("Database");
export const Assets = Cloudflare.R2.Bucket("Assets");

export default Cloudflare.Worker(
  "Backend",
  { main: import.meta.url },
  Effect.gen(function* () {
    const clerkSecretKey = yield* Config.redacted("CLERK_SECRET_KEY");
    const clerkPublishableKey = yield* Config.string(
      "VITE_CLERK_PUBLISHABLE_KEY",
    );
    const clerkAuthorizedParties = yield* Config.string(
      "CLERK_AUTHORIZED_PARTIES",
    );
    yield* Cloudflare.D1.QueryDatabase(Database);
    yield* Cloudflare.R2.ReadWriteBucket(Assets);
    yield* Cloudflare.AI.QueryGateway(AiGateway);

    // Clerk checks the token's `azp` claim against these frontend origins.
    // The API also uses this list for CORS, so paths and credentials are invalid.
    const authorizedParties = clerkAuthorizedParties.split(",").map((party) => {
      const url = new URL(party.trim());

      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username !== "" ||
        url.password !== "" ||
        url.pathname !== "/" ||
        url.search !== "" ||
        url.hash !== ""
      ) {
        throw new Error(
          "CLERK_AUTHORIZED_PARTIES must contain only exact HTTP(S) origins",
        );
      }

      return url.origin;
    });
    const authorizedPartySet = new Set(authorizedParties);
    const clerk = createClerkClient({
      publishableKey: clerkPublishableKey,
      secretKey: Redacted.value(clerkSecretKey),
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const webRequest = yield* Cloudflare.Workers.Request;
        const url = new URL(request.originalUrl);
        const origin = webRequest.headers.get("origin");
        const corsHeaders =
          origin !== null && authorizedPartySet.has(origin)
            ? {
                "access-control-allow-headers": "Authorization, Content-Type",
                "access-control-allow-methods": "GET, POST, OPTIONS",
                "access-control-allow-origin": origin,
                vary: "Origin",
              }
            : undefined;

        if (request.method === "OPTIONS") {
          if (corsHeaders === undefined) {
            return HttpServerResponse.empty({ status: 403 });
          }

          return HttpServerResponse.empty({ headers: corsHeaders, status: 204 });
        }

        if (request.method === "GET" && url.pathname === "/health") {
          return yield* HttpServerResponse.json(
            { ok: true },
            { headers: corsHeaders },
          );
        }

        const authentication = yield* authenticateSession(
          clerk,
          webRequest,
          authorizedParties,
        );

        if (authentication.status === "unavailable") {
          return yield* HttpServerResponse.json(
            { error: "Authentication service unavailable" },
            { headers: corsHeaders, status: 503 },
          );
        }

        if (authentication.status === "unauthenticated") {
          return yield* HttpServerResponse.json(
            { error: "Unauthorized" },
            { headers: corsHeaders, status: 401 },
          );
        }

        if (request.method === "GET" && url.pathname === "/api/me") {
          return yield* HttpServerResponse.json(
            {
              organizationId: authentication.organizationId,
              userId: authentication.userId,
            },
            { headers: corsHeaders },
          );
        }

        return HttpServerResponse.text("Not found", {
          headers: corsHeaders,
          status: 404,
        });
      }),
    };
  }).pipe(
    Effect.provide([
      Cloudflare.D1.QueryDatabaseBinding,
      Cloudflare.R2.ReadWriteBucketBinding,
      Cloudflare.AI.QueryGatewayBinding,
    ]),
  ),
);
