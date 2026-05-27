const { parseNonNegativeInteger } = require("../helpers/normalize-numbers")

const PERSONAL_INFORMATION_FIELDS = [
  "first_name",
  "middle_name",
  "last_name",
  "email",
  "phone_number",
  "address",
  "linkedin_url",
  "github_url",
  "portfolio_url",
  "resume_file_path",
  "projects_portfolio_file_path",
  "certifications_folder_path",
  "ethnicity",
  "gender",
  "age",
  "veteran_status",
  "disability_status",
  "education_level",
  "years_of_experience"
];

const PERSONAL_INFORMATION_DEFAULTS = {
  first_name: "",
  middle_name: "",
  last_name: "",
  email: "",
  phone_number: "",
  address: "",
  linkedin_url: "",
  github_url: "",
  portfolio_url: "",
  resume_file_path: "",
  projects_portfolio_file_path: "",
  certifications_folder_path: "",
  ethnicity: "",
  gender: "",
  age: 0,
  veteran_status: "",
  disability_status: "",
  education_level: "",
  years_of_experience: 0
};


function normalizePersonalInformationInput(value) {
  const source = value && typeof value === "object" ? value : {};
  const normalized = createDefaultPersonalInformation();
  const numericFields = new Set(["age", "years_of_experience"]);
  const textFields = PERSONAL_INFORMATION_FIELDS.filter((field) => !numericFields.has(field));

  for (const field of textFields) {
    normalized[field] = String(source[field] ?? "").trim();
  }

  normalized.age = parseNonNegativeInteger(source.age);
  normalized.years_of_experience = parseNonNegativeInteger(source.years_of_experience);

  return normalized;
}

function createDefaultPersonalInformation() {
  return { ...PERSONAL_INFORMATION_DEFAULTS };
}

module.exports = { normalizePersonalInformationInput, createDefaultPersonalInformation, PERSONAL_INFORMATION_FIELDS };