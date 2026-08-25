import * as Cloudflare from "alchemy/Cloudflare";

const DAILY_SPEND_LIMIT_CENTS = 10_00;

export const AiGateway = Cloudflare.AI.Gateway("AiGateway", {
  authentication: true,
  cacheTtl: null,
  collectLogs: false,
  spendLimits: {
    enabled: true,
    rules: [
      {
        limitType: "cost",
        limit: DAILY_SPEND_LIMIT_CENTS,
        technique: "sliding",
        window: "1 day",
      },
    ],
  },
});
