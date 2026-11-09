import { z } from "zod";

import { handler, ok, parseBody } from "@/lib/api";
import { auditAs } from "@/lib/audit";
import { createTask, listTasks } from "@/server/crm";

export const dynamic = "force-dynamic";

export const GET = handler({ permission: "task:read" }, async ({ principal, searchParams }) => {
  return listTasks(principal, {
    status: searchParams.get("status") ?? undefined,
    mine: searchParams.get("mine") === "1",
    customerId: searchParams.get("customerId") ?? undefined,
    dealId: searchParams.get("dealId") ?? undefined,
  });
});

const schema = z.object({
  title: z.string().min(2),
  description: z.string().nullable().optional(),
  dueAt: z.string().nullable().optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional(),
  assignedToId: z.string().nullable().optional(),
  customerId: z.string().nullable().optional(),
  dealId: z.string().nullable().optional(),
  leadId: z.string().nullable().optional(),
});

export const POST = handler({ permission: "task:write" }, async ({ principal, request }) => {
  const input = await parseBody(request, schema);
  const task = await createTask(principal, input);
  await auditAs(principal, "CREATE", "Task", task.id, { title: task.title }, request);
  return ok(task, undefined, { status: 201 });
});
