import { useAction, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { FunctionArgs } from "convex/server";
import type { t3ProofIntent } from "../../../../shared/t3-doctor";

export type ConnectionChange = FunctionArgs<typeof api.t3_keys.change>["change"];
export type RequestT3Proof = (intent: ReturnType<typeof t3ProofIntent>) => Promise<{ challengeId: string }>;

export function useT3ReleaseAvailable() {
  return Boolean(useQuery(api.t3_keys.settings, {})?.release);
}

export function useT3Connection(team: boolean) {
  const settings = useQuery(api.t3_keys.settings, {});
  const keys = usePaginatedQuery(api.t3_keys.keys, settings && (!team || settings.owner) ? { team } : "skip", { initialNumItems: 10 });
  return { settings, keys, change: useMutation(api.t3_keys.change) };
}

/** Action-bound proof delivered by the shared identity sender to the holder's own mailbox. */
export function useT3Proof(): RequestT3Proof {
  const send = useAction(api.identity.sendChallengeCode);
  return async ({ action, intendedChange }) => {
    const { challengeId } = await send({ purpose: action, target: intendedChange });
    return { challengeId };
  };
}
