import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { badRequest, handler, notFound, ok, parseBody } from "@/lib/api";
import { db } from "@/lib/db";
import { scope } from "@/lib/tenant";

export const dynamic = "force-dynamic";

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads", "visits");
const MAX_BYTES = 4 * 1024 * 1024;

const schema = z.object({
  /** Base64 JPEG, optionally with a data: prefix. */
  image: z.string().min(64),
  caption: z.string().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  takenAt: z.string().optional(),
  clientUuid: z.string().optional(),
});

/**
 * Visit photo upload from the field app.
 *
 * Files land on local disk under /public/uploads. That is fine for a single
 * VPS deployment and deliberately simple; a multi-instance deployment needs
 * object storage instead, which is a config change here rather than a redesign
 * because only this route touches the filesystem.
 */
export const POST = handler<{ id: string }>(
  { permission: "visit:write" },
  async ({ principal, params, request }) => {
    const visit = await db.visit.findFirst({
      where: { id: params.id, ...scope(principal, { selfField: "repId" }) },
    });
    if (!visit) throw notFound("Visit not found");

    const input = await parseBody(request, schema);

    if (input.clientUuid) {
      const existing = await db.visitPhoto.findUnique({
        where: { clientUuid: input.clientUuid },
      });
      if (existing) return ok(existing, { replayed: true });
    }

    const base64 = input.image.includes(",")
      ? input.image.slice(input.image.indexOf(",") + 1)
      : input.image;

    let buffer: Buffer;
    try {
      buffer = Buffer.from(base64, "base64");
    } catch {
      throw badRequest("Image is not valid base64");
    }
    if (buffer.byteLength === 0) throw badRequest("Image is empty");
    if (buffer.byteLength > MAX_BYTES) {
      throw badRequest("Image exceeds the 4MB limit — compress before upload");
    }

    await mkdir(UPLOAD_DIR, { recursive: true });
    const filename = `${randomUUID()}.jpg`;
    await writeFile(path.join(UPLOAD_DIR, filename), buffer);

    const photo = await db.visitPhoto.create({
      data: {
        visitId: visit.id,
        url: `/uploads/visits/${filename}`,
        caption: input.caption ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        takenAt: input.takenAt ? new Date(input.takenAt) : new Date(),
        clientUuid: input.clientUuid ?? null,
      },
    });

    return ok(photo, undefined, { status: 201 });
  },
);

export const GET = handler<{ id: string }>(
  { permission: "visit:read" },
  async ({ principal, params }) => {
    const visit = await db.visit.findFirst({
      where: { id: params.id, ...scope(principal, { selfField: "repId" }) },
      include: { photos: { orderBy: { takenAt: "desc" } } },
    });
    if (!visit) throw notFound("Visit not found");
    return visit.photos;
  },
);
