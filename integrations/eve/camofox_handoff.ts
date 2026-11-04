//agent/tools/camofox_handoff.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  CamofoxTabIdSchema,
  camofoxPostBody,
  camofoxRequest,
  getCamofoxUserId,
  parseCamofoxResponse,
  readCamofoxJson,
} from "../lib/camofox.js";

const DEFAULT_IDLE_MINUTES = 10;
// Lifetime of the control link. The server also ends control when the
// handoff ends, so this only needs to outlast a handoff.
const CONTROL_LINK_TTL_SECONDS = 60 * 60;

const StatusSchema = z.object({
  mode: z.enum(["agent", "human"]),
  until: z.string().optional(),
  reason: z.string().optional(),
});

const HandoffOutputSchema = z.object({
  ok: z.literal(true),
  action: z.enum(["start", "release", "status"]),
  mode: z.enum(["agent", "human"]),
  until: z.string().nullable(),
  reason: z.string().nullable(),
  // Present only after "start". Send this link to the user, and only to them.
  controlUrl: z.string().nullable(),
});

const HandoffStartResponseSchema = z.object({
  ok: z.literal(true),
  mode: z.literal("human"),
  until: z.string(),
  reason: z.string(),
});

const ReleaseResponseSchema = z.object({
  ok: z.literal(true),
  mode: z.literal("agent"),
});

const LinkResponseSchema = z.object({
  url: z.string().url(),
});

/**
 * Accept only an https viewer link, or a local http link outside production.
 * The link is a bearer credential, so anything else is refused.
 */
function checkedControlUrl(value: string): string {
  const url = new URL(value);
  const localHttpAllowed =
    process.env.NODE_ENV !== "production" &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !localHttpAllowed) ||
    url.username ||
    url.password ||
    !url.searchParams.get("t")
  ) {
    throw new Error("Camofox returned an invalid live viewer URL.");
  }
  return url.toString();
}

function isConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes("(HTTP 409)");
}

export default defineTool({
  description:
    "Hand the browser tab to the user so they can act on it, for example to sign in, enter a code, or solve a check. Use action 'start' with a short reason the user will understand. It returns controlUrl: send that link to the user in chat, and only to them. While the handoff is active, other browser actions on this tab are refused, so do not act on the page; wait for the user. The user returns control with the Done button on the link. Use action 'release' to return control yourself once the user says they are finished, or if the handoff is no longer needed. Use action 'status' to check whether the user still holds the tab. A handoff ends on its own after the idle time with no input from the user. Never ask the user to type a password into the chat: have them type it into the live view instead.",
  inputSchema: z.object({
    tabId: CamofoxTabIdSchema,
    action: z.enum(["start", "release", "status"]),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Required for start. Shown to the user, for example 'Sign in to your bank'."),
    idleMinutes: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(DEFAULT_IDLE_MINUTES)
      .describe("Minutes with no input from the user before control returns to the agent."),
  }),
  outputSchema: HandoffOutputSchema,
  async execute({ tabId, action, reason, idleMinutes }, ctx) {
    const userId = getCamofoxUserId(ctx.session.auth.current);
    const tab = encodeURIComponent(tabId);
    const idleMs = idleMinutes * 60 * 1000;

    if (action === "status") {
      const response = await camofoxRequest(
        `/tabs/${tab}/control`,
        userId,
        ctx.abortSignal,
        "handoff status",
      );
      const status = parseCamofoxResponse(
        StatusSchema,
        await readCamofoxJson(response, "handoff status"),
        "handoff status",
      );
      return {
        ok: true as const,
        action,
        mode: status.mode,
        until: status.until ?? null,
        reason: status.reason ?? null,
        controlUrl: null,
      };
    }

    if (action === "release") {
      const response = await camofoxRequest(
        `/tabs/${tab}/handoff/release`,
        userId,
        ctx.abortSignal,
        "handoff release",
        { method: "POST", body: camofoxPostBody(userId, {}) },
      );
      parseCamofoxResponse(
        ReleaseResponseSchema,
        await readCamofoxJson(response, "handoff release"),
        "handoff release",
      );
      return {
        ok: true as const,
        action,
        mode: "agent" as const,
        until: null,
        reason: null,
        controlUrl: null,
      };
    }

    // start
    if (!reason) {
      throw new Error("A reason is required to start a handoff, so the user knows what to do.");
    }

    const started = await camofoxRequest(
      `/tabs/${tab}/handoff`,
      userId,
      ctx.abortSignal,
      "handoff start",
      {
        method: "POST",
        body: camofoxPostBody(userId, { reason, idleMs }),
      },
    ).then((response) =>
      readCamofoxJson(response, "handoff start").then((value) =>
        parseCamofoxResponse(HandoffStartResponseSchema, value, "handoff start"),
      ),
    ).catch((error: unknown) => {
      if (isConflict(error)) {
        throw new Error("The handoff could not start because the tab is already under a handoff.");
      }
      throw error;
    });

    // Issue the control link. If this fails, release the handoff so the agent
    // is not left blocked on a tab nobody can reach.
    let controlUrl: string;
    try {
      const linkResponse = await camofoxRequest(
        "/live-viewer/links",
        userId,
        ctx.abortSignal,
        "issue control link",
        {
          method: "POST",
          body: camofoxPostBody(userId, {
            tabId,
            control: true,
            ttlSeconds: CONTROL_LINK_TTL_SECONDS,
          }),
        },
      );
      const link = parseCamofoxResponse(
        LinkResponseSchema,
        await readCamofoxJson(linkResponse, "issue control link"),
        "issue control link",
      );
      controlUrl = checkedControlUrl(link.url);
    } catch (error) {
      await camofoxRequest(
        `/tabs/${tab}/handoff/release`,
        userId,
        ctx.abortSignal,
        "handoff release after failed link",
        { method: "POST", body: camofoxPostBody(userId, {}) },
      ).catch(() => undefined);
      if (isConflict(error)) {
        throw new Error("The handoff could not start because the tab is already under a handoff.");
      }
      throw error;
    }

    return {
      ok: true as const,
      action,
      mode: started.mode,
      until: started.until,
      reason: started.reason,
      controlUrl,
    };
  },
});
