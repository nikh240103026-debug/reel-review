import "server-only";
import { getDb } from "@/lib/db";
import { randomToken, sha256Hex } from "@/lib/crypto";
import { badRequest, notFound, unauthorized } from "@/lib/http";
import { ADAPTERS, ADAPTER_IDS } from "@/shared/operations";
import { recordActivity } from "./activity";
import type { DeviceDTO } from "@/shared/dto";

const ONLINE_WINDOW_MS = 90_000;
const hashDeviceToken = (t: string) => sha256Hex(`agent-device:${t}`);
const hashRegistrationCode = (c: string) => sha256Hex(`agent-registration:${c.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}`);

function sanitizeAdapters(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((a): a is string => typeof a === "string" && (ADAPTER_IDS as readonly string[]).includes(a)))]
    // only implemented adapters can ever receive jobs
    .filter((a) => ADAPTERS[a as keyof typeof ADAPTERS].implemented);
}

type DeviceRow = Omit<DeviceDTO, "online">;

function toDTO(r: DeviceRow): DeviceDTO {
  return {
    ...r,
    online: r.status === "active" && !!r.last_seen_at && Date.now() - new Date(r.last_seen_at).getTime() < ONLINE_WINDOW_MS,
  };
}

const DEVICE_COLS = `id, name, status, platform, agent_version, adapters, capabilities, last_seen_at, registered_at, revoked_at,
  registration_expires_at, created_at`;

export async function listDevices(): Promise<DeviceDTO[]> {
  const db = await getDb();
  const rows = await db.query<DeviceRow>(`select ${DEVICE_COLS} from agent_devices order by status = 'revoked', created_at desc`);
  return rows.map(toDTO);
}

/** Creates a pending device and a one-time registration code (valid 15 minutes). */
export async function createRegistration(name: string, actor: string) {
  const db = await getDb();
  const raw = randomToken(12).replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 12).padEnd(12, "X");
  const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  const id = await db.tx(async (q) => {
    const [row] = await q.query<{ id: string }>(
      `insert into agent_devices (name, status, registration_code_hash, registration_expires_at)
       values ($1, 'pending', $2, now() + interval '15 minutes') returning id`,
      [name, hashRegistrationCode(code)],
    );
    await recordActivity(q, { actorType: "editor", actorName: actor, eventType: "device.registration_created", data: { device_id: row!.id, name } });
    return row!.id;
  });
  return { deviceId: id, code };
}

export async function registerDevice(
  code: string,
  info: { platform?: string; agentVersion?: string; adapters?: unknown; capabilities?: unknown },
) {
  const db = await getDb();
  const token = randomToken(32);
  return db.tx(async (q) => {
    const [row] = await q.query<{ id: string; name: string; registration_expires_at: string | null }>(
      `select id, name, registration_expires_at from agent_devices
        where registration_code_hash = $1 and status = 'pending' for update`,
      [hashRegistrationCode(code)],
    );
    if (!row) throw unauthorized("Invalid or already used registration code");
    if (!row.registration_expires_at || new Date(row.registration_expires_at).getTime() < Date.now()) {
      throw unauthorized("Registration code expired. Create a new one in Settings.");
    }
    await q.query(
      `update agent_devices set status = 'active', token_hash = $2, registration_code_hash = null, registration_expires_at = null,
         platform = $3, agent_version = $4, adapters = $5::jsonb, capabilities = $6::jsonb, registered_at = now(), last_seen_at = now()
       where id = $1`,
      [
        row.id,
        hashDeviceToken(token),
        info.platform?.slice(0, 100) ?? null,
        info.agentVersion?.slice(0, 40) ?? null,
        JSON.stringify(sanitizeAdapters(info.adapters)),
        JSON.stringify(info.capabilities ?? {}).length < 20_000 ? JSON.stringify(info.capabilities ?? {}) : "{}",
      ],
    );
    await recordActivity(q, { actorType: "agent", actorName: row.name, eventType: "device.registered", data: { device_id: row.id } });
    return { deviceId: row.id, name: row.name, token };
  });
}

export interface AuthedDevice {
  id: string;
  name: string;
  adapters: string[];
}

/** Authenticates an agent request (Authorization: Bearer <device token>). */
export async function authenticateDevice(req: Request): Promise<AuthedDevice> {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+([A-Za-z0-9_-]{40,64})$/.exec(header);
  if (!m) throw unauthorized("Device token required");
  const db = await getDb();
  const [row] = await db.query<{ id: string; name: string; adapters: string[]; status: string; last_seen_at: string | null }>(
    "select id, name, adapters, status, last_seen_at from agent_devices where token_hash = $1",
    [hashDeviceToken(m[1]!)],
  );
  if (!row || row.status !== "active") throw unauthorized("Unknown or revoked device");
  if (!row.last_seen_at || Date.now() - new Date(row.last_seen_at).getTime() > 15_000) {
    await db.query("update agent_devices set last_seen_at = now() where id = $1", [row.id]);
  }
  return { id: row.id, name: row.name, adapters: row.adapters };
}

export async function updateDeviceCapabilities(deviceId: string, info: { adapters?: unknown; capabilities?: unknown; agentVersion?: string }) {
  const db = await getDb();
  const caps = JSON.stringify(info.capabilities ?? {});
  await db.query(
    `update agent_devices set adapters = $2::jsonb, capabilities = $3::jsonb, agent_version = coalesce($4, agent_version), last_seen_at = now()
      where id = $1 and status = 'active'`,
    [deviceId, JSON.stringify(sanitizeAdapters(info.adapters)), caps.length < 20_000 ? caps : "{}", info.agentVersion ?? null],
  );
}

export async function revokeDevice(deviceId: string, actor: string) {
  const db = await getDb();
  await db.tx(async (q) => {
    const [row] = await q.query<{ name: string; status: string }>("select name, status from agent_devices where id = $1 for update", [deviceId]);
    if (!row) throw notFound("Device not found");
    if (row.status === "revoked") return;
    await q.query(
      "update agent_devices set status = 'revoked', token_hash = null, registration_code_hash = null, revoked_at = now() where id = $1",
      [deviceId],
    );
    // Jobs held by this device go back to the queue (their lease is voided).
    await q.query(
      `update edit_jobs set status = 'queued', claimed_by_device_id = null, lease_expires_at = null,
         progress_message = 'Device revoked; returned to queue'
       where claimed_by_device_id = $1 and status = 'running'`,
      [deviceId],
    );
    await q.query("update edit_jobs set target_device_id = null where target_device_id = $1 and status = 'queued'", [deviceId]);
    await recordActivity(q, { actorType: "editor", actorName: actor, eventType: "device.revoked", data: { device_id: deviceId, name: row.name } });
  });
}

export async function renameDevice(deviceId: string, name: string) {
  if (!name.trim()) throw badRequest("Name required");
  const db = await getDb();
  await db.query("update agent_devices set name = $2 where id = $1", [deviceId, name.trim().slice(0, 100)]);
}
