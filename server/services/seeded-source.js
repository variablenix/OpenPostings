
async function upsertSeededCompanySource(targetDb, payload = {}) {
  const companyName = String(payload?.company_name || "").trim();
  const sourceUrl = String(payload?.url_string || "").trim();
  const atsName = String(payload?.ATS_name || "").trim().toLowerCase();
  if (!sourceUrl) {
    throw new Error("Source URL is required.");
  }
  if (!companyName) {
    throw new Error("Company name is required.");
  }
  if (!atsName) {
    throw new Error("ATS name is required.");
  }

  const existingRow = await targetDb.get(
    `
      SELECT id, company_name, url_string, ATS_name
      FROM companies
      WHERE url_string = ?
      LIMIT 1;
    `,
    [sourceUrl]
  );

  await targetDb.run(
    `
      INSERT INTO companies (company_name, url_string, ATS_name)
      VALUES (?, ?, ?)
      ON CONFLICT(url_string) DO UPDATE SET
        company_name = excluded.company_name,
        ATS_name = excluded.ATS_name;
    `,
    [companyName, sourceUrl, atsName]
  );

  const row = await targetDb.get(
    `
      SELECT id, company_name, url_string, ATS_name
      FROM companies
      WHERE url_string = ?
      LIMIT 1;
    `,
    [sourceUrl]
  );

  return {
    row,
    action: existingRow ? "updated" : "inserted"
  };
}

module.exports = { upsertSeededCompanySource };