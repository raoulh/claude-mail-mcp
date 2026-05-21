/**
 * Calendar tool registry.
 *
 * Four tools: discover calendars, list events in a window, create new
 * events, find free time slots across one or more calendars.
 *
 * All times are ISO 8601 with timezone offset (e.g. 2026-05-22T09:00:00+02:00).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CalDavClient } from "./caldav-client.js";

function asJson(value: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

const isoDateTime = z
  .string()
  .describe(
    "ISO 8601 datetime with timezone offset, e.g. 2026-05-22T09:00:00+02:00"
  );

export function registerCalendarTools(
  server: McpServer,
  caldav: CalDavClient
): void {
  server.registerTool(
    "list_calendars",
    {
      description:
        "List all CalDAV calendars on the configured account. Returns URL (used as `calendar_url` in other tools), display name, timezone, and supported components.",
      inputSchema: {},
    },
    async () => {
      return asJson(await caldav.listCalendars());
    }
  );

  server.registerTool(
    "list_events",
    {
      description:
        "List events in a calendar between two timestamps. Recurring events are expanded into individual instances.",
      inputSchema: {
        calendar_url: z
          .string()
          .url()
          .describe("Calendar URL as returned by list_calendars"),
        start: isoDateTime.describe("Window start (inclusive)"),
        end: isoDateTime.describe("Window end (exclusive)"),
      },
    },
    async ({ calendar_url, start, end }) => {
      const events = await caldav.listEvents(calendar_url, start, end);
      return asJson({ count: events.length, events });
    }
  );

  server.registerTool(
    "create_event",
    {
      description:
        "Create a new calendar event. WRITE OPERATION. Use all_day=true for date-only events (start/end should then be YYYY-MM-DD; end is exclusive — for a one-day event set end to the day after).",
      inputSchema: {
        calendar_url: z
          .string()
          .url()
          .describe("Calendar URL as returned by list_calendars"),
        summary: z.string().min(1).describe("Event title"),
        start: isoDateTime,
        end: isoDateTime,
        all_day: z.boolean().optional(),
        description: z.string().optional(),
        location: z.string().optional(),
        attendees: z
          .array(z.string().email())
          .optional()
          .describe(
            "Email addresses of attendees. Note: CalDAV does NOT send invitations on its own — most servers expect the client to mail the iMIP invite separately."
          ),
      },
    },
    async (args) => {
      const result = await caldav.createEvent({
        calendarUrl: args.calendar_url,
        summary: args.summary,
        description: args.description,
        location: args.location,
        start: args.start,
        end: args.end,
        allDay: args.all_day,
        attendees: args.attendees,
      });
      return asJson({ success: true, ...result });
    }
  );

  server.registerTool(
    "find_free_slot",
    {
      description:
        "Find free time slots across one or more calendars in a window. Returns continuous gaps long enough to fit `duration_minutes`. Optional working hours restrict the search to a daily window (in UTC; pass start/end already in your local TZ if you want local-time anchoring).",
      inputSchema: {
        calendar_urls: z
          .array(z.string().url())
          .min(1)
          .describe("One or more calendar URLs to consider busy"),
        range_start: isoDateTime,
        range_end: isoDateTime,
        duration_minutes: z
          .number()
          .int()
          .min(5)
          .max(24 * 60)
          .describe("Minimum slot length in minutes"),
        working_hours: z
          .object({
            start_hour: z.number().int().min(0).max(23),
            end_hour: z.number().int().min(1).max(24),
          })
          .optional()
          .describe(
            "Restrict slots to this daily UTC window (e.g. 8–18 for 09:00–19:00 in CEST)"
          ),
      },
    },
    async (args) => {
      const slots = await caldav.findFreeSlots(
        args.calendar_urls,
        args.range_start,
        args.range_end,
        args.duration_minutes,
        args.working_hours
          ? {
              startHour: args.working_hours.start_hour,
              endHour: args.working_hours.end_hour,
            }
          : undefined
      );
      return asJson({ count: slots.length, slots });
    }
  );
}
