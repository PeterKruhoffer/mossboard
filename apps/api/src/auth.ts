import type { ClerkClient } from "@clerk/backend";
import * as Effect from "effect/Effect";

export type AuthenticationResult =
  | {
      readonly status: "authenticated";
      readonly userId: string;
      readonly sessionId: string;
      readonly organizationId: string | undefined;
    }
  | { readonly status: "unauthenticated" }
  | { readonly status: "unavailable" };

export const authenticateSession = Effect.fn("authenticateSession")(function* (
  clerk: ClerkClient,
  request: Request,
  authorizedParties: readonly string[],
): Effect.fn.Return<AuthenticationResult> {
  const state = yield* Effect.tryPromise(() =>
    clerk.authenticateRequest(request, {
      acceptsToken: "session_token",
      authorizedParties: [...authorizedParties],
    }),
  ).pipe(Effect.option);

  if (state._tag === "None") {
    return { status: "unavailable" };
  }

  if (!state.value.isAuthenticated) {
    return { status: "unauthenticated" };
  }

  const auth = state.value.toAuth();

  return {
    status: "authenticated",
    userId: auth.userId,
    sessionId: auth.sessionId,
    organizationId: auth.orgId ?? undefined,
  };
});
