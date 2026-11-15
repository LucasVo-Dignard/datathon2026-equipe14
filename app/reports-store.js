'use strict';
// ---------------------------------------------------------------------------
// Stockage des rapports simulés.
//
//   - REPORTS_BUCKET défini -> bucket S3 privé (infra/reports.tf), un objet JSON
//                              par rapport : reports/<utilisateur>/<id>.json
//   - sinon                 -> fichier JSON du prototype (db.reports)
//
// Un rapport a la forme { id, owner, period, title, asOf, createdAt, highlights,
// content }, plus scheduled et scheduledFor pour un rapport programmé.
// On garde les MAX_REPORTS plus récents par utilisateur.
// ---------------------------------------------------------------------------

const MAX_REPORTS = 20;
const byNewest = (a, b) => b.createdAt - a.createdAt;

function createJsonStore({ db, saveDb }) {
  db.reports ??= {};
  const own = (username) => Object.values(db.reports).filter((r) => r.owner === username).sort(byNewest);
  return {
    kind: 'json',
    async list(username) {
      return own(username);
    },
    async save(report) {
      db.reports[report.id] = report;
      for (const old of own(report.owner).slice(MAX_REPORTS)) delete db.reports[old.id];
      saveDb();
      return report;
    },
    async remove(username, id) {
      const report = Object.hasOwn(db.reports, id) ? db.reports[id] : null;
      if (!report || report.owner !== username) return false;
      delete db.reports[id];
      saveDb();
      return true;
    },
  };
}

function createS3Store({ bucket, client }) {
  const {
    S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand,
  } = require('@aws-sdk/client-s3');
  // Same region default as bot.js: the EC2's user_data sets AWS_REGION, the AWS
  // Batch job definition AWS_DEFAULT_REGION, and locally neither may be set.
  const s3 = client || new S3Client({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1' });
  const prefix = (username) => `reports/${encodeURIComponent(username)}/`;
  const key = (username, id) => `${prefix(username)}${id}.json`;

  async function keys(username) {
    const objects = [];
    let token;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix(username), ContinuationToken: token }));
      objects.push(...(page.Contents || []));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return objects.sort((a, b) => b.LastModified - a.LastModified).map((o) => o.Key);
  }

  return {
    kind: 's3',
    async list(username) {
      const reports = await Promise.all((await keys(username)).slice(0, MAX_REPORTS).map(async (Key) => {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key }));
        return JSON.parse(await res.Body.transformToString('utf-8'));
      }));
      return reports.sort(byNewest);
    },
    async save(report) {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key(report.owner, report.id),
        Body: JSON.stringify(report),
        ContentType: 'application/json; charset=utf-8',
      }));
      const old = (await keys(report.owner)).slice(MAX_REPORTS);
      await Promise.all(old.map((Key) => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key }))));
      return report;
    },
    async remove(username, id) {
      if (!(await keys(username)).includes(key(username, id))) return false;
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key(username, id) }));
      return true;
    },
  };
}

function createReportStore({ db, saveDb, bucket = process.env.REPORTS_BUCKET, client }) {
  return bucket ? createS3Store({ bucket, client }) : createJsonStore({ db, saveDb });
}

module.exports = { createReportStore, MAX_REPORTS };
