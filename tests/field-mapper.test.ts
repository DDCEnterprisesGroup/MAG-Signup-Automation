import assert from "node:assert/strict";
import test from "node:test";
import { detectRestrictedSensitiveField, getDefaultFieldRegistry, matchProfileField, normalizeDob, type FieldDescriptor } from "../src/forms/field-mapper.js";

function field(overrides: Partial<FieldDescriptor>): FieldDescriptor {
  return {
    domIndex: 0,
    tag: "input",
    type: "text",
    required: true,
    invalid: false,
    disabled: false,
    readOnly: false,
    currentValue: "",
    label: "",
    placeholder: "",
    name: "",
    id: "",
    autocomplete: "",
    ariaLabel: "",
    nearbyText: "",
    ...overrides,
  };
}

test("maps supported profile synonyms with high confidence", () => {
  assert.equal(matchProfileField(field({ label: "Given Name" }))?.field, "firstName");
  assert.equal(matchProfileField(field({ name: "family_name" }))?.field, "lastName");
  assert.equal(matchProfileField(field({ type: "email" }))?.field, "email");
  assert.equal(matchProfileField(field({ autocomplete: "postal-code" }))?.field, "zip");
  assert.equal(matchProfileField(field({ label: "Mobile Phone", type: "tel" }))?.field, "phone");
});

test("does not guess unsupported or ambiguous fields", () => {
  assert.equal(matchProfileField(field({ label: "Preferred display value" })), null);
  assert.equal(matchProfileField(field({ label: "City / Region" })), null);
  assert.equal(matchProfileField(field({ type: "password", label: "Password" })), null);
});

test("tel and generic numeric inputs are not phone fields without affirmative phone semantics", () => {
  assert.equal(matchProfileField(field({ type: "tel" })), null);
  assert.equal(matchProfileField(field({ type: "number", label: "Member Number", name: "member_number" })), null);
});

test("sensitive semantics override tel and phone attributes", () => {
  const descriptor = field({
    type: "tel",
    label: "Social Security Number",
    name: "phone",
    id: "mobile_phone",
    autocomplete: "tel",
    placeholder: "9 digits",
  });
  assert.match(detectRestrictedSensitiveField(descriptor)?.reason ?? "", /Social Security/i);
  assert.equal(matchProfileField(descriptor), null);
});

test("sensitive semantics override conflicting autocomplete and input types", () => {
  const descriptor = field({
    type: "email",
    label: "Contact",
    ariaLabel: "Tax ID",
    name: "email",
    autocomplete: "email",
    nearbyText: "Enter taxpayer identification number",
  });
  assert.match(detectRestrictedSensitiveField(descriptor)?.reason ?? "", /tax identification/i);
  assert.equal(matchProfileField(descriptor), null);
});

test("detects restricted data semantics in every supported context source", () => {
  const restricted = [
    field({ label: "Government ID" }),
    field({ placeholder: "Routing" }),
    field({ name: "credit_card" }),
    field({ id: "passport_number" }),
    field({ ariaLabel: "Security Answer" }),
    field({ autocomplete: "cc-number" }),
    field({ nearbyText: "Enter your PIN" }),
  ];
  for (const descriptor of restricted) {
    assert.ok(detectRestrictedSensitiveField(descriptor));
    assert.equal(matchProfileField(descriptor), null);
  }
});

test("maps new approved fields with context restrictions", () => {
  assert.equal(matchProfileField(field({ label: "Date of Birth" }))?.field, "dob");
  assert.equal(matchProfileField(field({ label: "Current Occupation" }))?.field, "occupation");
  assert.equal(matchProfileField(field({ label: "Gross Annual Income" }))?.field, "annualIncome");
  assert.equal(matchProfileField(field({ label: "Monthly Income" })), null);
  assert.equal(matchProfileField(field({ label: "Employer" })), null);
});

test("registration password policy is explicit and context-bound", () => {
  const password = field({ type: "password", label: "Create Password", autocomplete: "new-password" });
  assert.equal(matchProfileField(password), null);
  assert.equal(matchProfileField(password, { accountFlow: "login" }), null);
  assert.equal(matchProfileField(password, { accountFlow: "password-reset" }), null);
  assert.equal(matchProfileField(password, { accountFlow: "registration" })?.field, "password");
});

test("normalizes supported DOB formats without logging or guessing invalid dates", () => {
  assert.deepEqual(normalizeDob("1/2/1990"), {
    year: "1990",
    month: "01",
    day: "02",
    iso: "1990-01-02",
    display: "01/02/1990",
  });
  assert.equal(normalizeDob("1990-01-02")?.display, "01/02/1990");
  assert.equal(normalizeDob("02/30/1990"), undefined);
});

test("a registry-only normal field can be added without a source-code profile property", () => {
  const registry = structuredClone(getDefaultFieldRegistry());
  registry.fields["FAVORITE COLOR"] = {
    profileField: "favoriteColor",
    aliases: ["favorite color", "preferred color"],
    autofill: true,
    sensitivity: "normal",
    transform: "text",
  };
  assert.equal(matchProfileField(field({ label: "Preferred Color" }), { registry })?.field, "favoriteColor");
});
