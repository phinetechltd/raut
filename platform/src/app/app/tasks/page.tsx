import Link from "next/link";

import {
  Badge,
  DataTable,
  FilterBar,
  FilterSelect,
  ModuleLocked,
  PageHeader,
  type Column,
  type Tone,
} from "@/components/ui";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/session";
import { isSelfScoped } from "@/lib/rbac";
import { listTasks } from "@/server/crm";

import { NewTaskDialog, TaskStatusButton, type Option } from "../crm/crm-client";

export const dynamic = "force-dynamic";

const PRIORITY_TONE: Record<string, Tone> = { LOW: "neutral", NORMAL: "info", HIGH: "warning" };
const STATUS_TONE: Record<string, Tone> = { OPEN: "info", DONE: "success", CANCELLED: "neutral" };

type TaskRow = Awaited<ReturnType<typeof listTasks>>[number];

function dueLabel(dueAt: Date | null, status: string) {
  if (!dueAt) return <span className="text-content-muted">—</span>;
  const overdue = status === "OPEN" && dueAt.getTime() < Date.now();
  const text = dueAt.toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" });
  return <span className={overdue ? "font-medium text-danger" : ""}>{text}{overdue ? " · overdue" : ""}</span>;
}

export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { companyId, principal } = await requireTenant();
  if (!principal.enabledModules.has("CRM")) return <ModuleLocked module="CRM" />;

  const params = await searchParams;
  const status = params.status ?? "OPEN";
  const mine = params.mine === "1";
  const tasks = await listTasks(principal, { status: status === "ALL" ? undefined : status, mine });

  const users = await db.user.findMany({
    where: { companyId, status: { not: "SUSPENDED" } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const customers = await db.customer.findMany({
    where: { companyId, status: "ACTIVE" },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 500,
  });
  const userOpts: Option[] = users;
  const nameOf = new Map(users.map((u) => [u.id, u.name]));

  const columns: Array<Column<TaskRow>> = [
    {
      key: "title",
      header: "Task",
      cell: (t) => (
        <div>
          <p className="font-medium">{t.title}</p>
          {t.customer ? (
            <Link href={`/app/customers/${t.customer.id}`} className="text-xs text-content-muted hover:text-accent">{t.customer.name}</Link>
          ) : t.description ? (
            <p className="line-clamp-1 text-xs text-content-muted">{t.description}</p>
          ) : null}
        </div>
      ),
    },
    { key: "due", header: "Due", cell: (t) => dueLabel(t.dueAt, t.status) },
    { key: "priority", header: "Priority", hideBelow: "md", cell: (t) => <Badge tone={PRIORITY_TONE[t.priority] ?? "neutral"}>{t.priority}</Badge> },
    { key: "assignee", header: "Owner", hideBelow: "lg", cell: (t) => (t.assignedToId ? nameOf.get(t.assignedToId) ?? "—" : "—") },
    { key: "status", header: "Status", cell: (t) => <Badge tone={STATUS_TONE[t.status] ?? "neutral"}>{t.status}</Badge> },
    { key: "actions", header: "", align: "right", cell: (t) => <TaskStatusButton taskId={t.id} status={t.status} /> },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tasks"
        description="Follow-ups and to-dos across the team."
        actions={<NewTaskDialog users={userOpts} customers={customers} />}
      />
      <FilterBar action="/app/tasks">
        <FilterSelect
          name="status"
          value={status}
          options={[
            { value: "OPEN", label: "Open" },
            { value: "DONE", label: "Done" },
            { value: "CANCELLED", label: "Cancelled" },
            { value: "ALL", label: "All statuses" },
          ]}
        />
        {!isSelfScoped(principal) ? (
          <FilterSelect
            name="mine"
            value={mine ? "1" : ""}
            allLabel="Everyone"
            options={[{ value: "1", label: "Assigned to me" }]}
          />
        ) : null}
      </FilterBar>
      <DataTable
        columns={columns}
        rows={tasks}
        getRowKey={(t) => t.id}
        caption="Tasks"
        empty={{ title: "No tasks here", description: "Create one with the New task button." }}
      />
    </div>
  );
}
