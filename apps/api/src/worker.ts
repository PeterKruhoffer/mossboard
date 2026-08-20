import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const Database = Cloudflare.D1.Database("Database");
export const Assets = Cloudflare.R2.Bucket("Assets");

export default Cloudflare.Worker(
  "Backend",
  { main: import.meta.url },
  Effect.gen(function* () {
    yield* Cloudflare.D1.QueryDatabase(Database);
    yield* Cloudflare.R2.ReadWriteBucket(Assets);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (request.method === "GET" && url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        return HttpServerResponse.text("Not found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide([
      Cloudflare.D1.QueryDatabaseBinding,
      Cloudflare.R2.ReadWriteBucketBinding,
    ]),
  ),
);
