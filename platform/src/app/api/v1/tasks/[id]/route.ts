import { z } from "zod";

import { handler, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { updateTask } from "@/server/crm";

export const dynamic = "force-dynamic";

const schema = z.object({
  title: z.string().min(2).optional(),
  description: z.string().nullable().optional(),
  dueAt: z.string().nullable().optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional(),
  assignedToId: z.string().nullable().optional(),
  status: z.enum(["OPEN", "DONE", "CANCELLED"]).optional(),
});

export const PATCH = handler<{ id: string }>({ permission: "task:write" }, async ({ principal, params, request }) => {
  const input = await parseBody(request, schema);
  const task = await updateTask(principal, params.id, input);
  await auditAs(principal, "UPDATE", "Task", task.id, input as Record<string, unknown>, request);
  return task;
});
