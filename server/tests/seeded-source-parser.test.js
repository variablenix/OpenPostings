const assert = require("assert");
const {
  classifySeededCompanySourceUrl,
  listSeededAtsValues,
  DYNAMIC_ATS_OPTIONS,
  SEEDED_ATS_OPTIONS
} = require("..");

function run() {
  const seededAtsValues = listSeededAtsValues();
  assert.ok(Array.isArray(seededAtsValues), "listSeededAtsValues should return an array");
  assert.ok(seededAtsValues.includes("workday"), "workday should be listed as seeded ATS");
  assert.ok(!seededAtsValues.includes("smartrecruiters"), "dynamic ATS should be excluded from seeded ATS list");

  const workday = classifySeededCompanySourceUrl("https://aah.wd5.myworkdayjobs.com/External");
  assert.equal(workday.supported, true, "Workday URL should be supported");
  assert.equal(workday.ats, "workday", "Workday ATS should be detected");
  assert.equal(workday.company_identifier, "External", "Workday identifier should come from company path segment");

  const greenhouse = classifySeededCompanySourceUrl("boards.greenhouse.io/insider");
  assert.equal(greenhouse.supported, true, "Greenhouse URL should be supported even without explicit scheme");
  assert.equal(greenhouse.ats, "greenhouse", "Greenhouse ATS should be detected");
  assert.equal(greenhouse.company_identifier, "insider", "Greenhouse identifier should be board token");

  const dynamic = classifySeededCompanySourceUrl("https://jobs.smartrecruiters.com/sr-jobs/search");
  assert.equal(dynamic.supported, false, "Dynamic ATS URL should not be supported");
  assert.equal(dynamic.reason, "dynamic_ats_not_supported", "Dynamic ATS URL should be explicitly rejected");
  assert.ok(DYNAMIC_ATS_OPTIONS.has("smartrecruiters"), "smartrecruiters should be in dynamic ATS set");

  const invalid = classifySeededCompanySourceUrl("not-a-url");
  assert.equal(invalid.supported, false, "Invalid URL should not be supported");
  assert.equal(invalid.reason, "unrecognized_or_not_seeded", "Unknown URL should be treated as unsupported seeded source");

  assert.ok(SEEDED_ATS_OPTIONS.has("workday"), "workday should exist in seeded ATS set");
  assert.ok(!SEEDED_ATS_OPTIONS.has("smartrecruiters"), "dynamic ATS should not exist in seeded ATS set");

  console.log("seeded-source-parser tests passed");
}

run();

