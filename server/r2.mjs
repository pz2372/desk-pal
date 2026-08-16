import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET;
const signingSecret = process.env.ARTIFACT_SIGNING_SECRET;

export const r2Configured = Boolean(accountId && accessKeyId && secretAccessKey && bucket && signingSecret);

const client = r2Configured ? new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
}) : undefined;

function tokenFor(id) {
  return createHmac("sha256", signingSecret).update(`desk-pal-artifact:${id}`).digest("hex");
}

function validToken(id, token) {
  if (!r2Configured || typeof token !== "string") return false;
  const expected = Buffer.from(tokenFor(id), "hex");
  const supplied = Buffer.from(token, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function keyFor(id, kind) {
  return `user-artifacts/${id}/${kind}.glb`;
}

export async function putR2Model(model, kind, existingId) {
  if (!r2Configured) return undefined;
  const id = existingId || randomUUID();
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: keyFor(id, kind),
    Body: model,
    ContentType: "model/gltf-binary",
    Metadata: { artifact: id, stage: kind },
  }));
  return { id, token: tokenFor(id) };
}

export async function getR2Model(reference, kind) {
  if (!r2Configured) throw new Error("R2 artifact storage is not configured.");
  const id = String(reference?.id || "");
  if (!/^[0-9a-f-]{36}$/.test(id) || !validToken(id, reference?.token)) {
    const error = new Error("The stored model reference is invalid.");
    error.status = 404;
    throw error;
  }
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(id, kind) }));
    const model = Buffer.from(await response.Body.transformToByteArray());
    if (model.length < 20 || model.subarray(0, 4).toString() !== "glTF") throw new Error("R2 returned an invalid GLB model.");
    return { model, reference: { id, token: reference.token } };
  } catch (error) {
    if (error?.status) throw error;
    const missing = new Error(`The stored ${kind} model is unavailable.`);
    missing.status = error?.$metadata?.httpStatusCode === 404 ? 410 : 502;
    throw missing;
  }
}
