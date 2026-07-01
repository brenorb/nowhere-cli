import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import { errorLogColumns, errorLogEntries, featureStories } from "./feature_stories.mjs";

const threadId = "019f1f28-49cd-7c71-bd95-085f3ed33f63";
const runDir = path.resolve("work/goals/feature-audit");
const outputDir = path.resolve("outputs", threadId);
const workbookPath = path.join(outputDir, "nowhere-cli-feature-audit.xlsx");

const columns = [
  "id",
  "area",
  "feature",
  "commands",
  "story",
  "expectedBehavior",
  "keyFlags",
  "codeRef",
  "tests",
  "coverageStatus",
  "storyStatus",
  "testStatus",
  "defectStatus",
  "fixCommit",
  "retestStatus",
  "notes",
];

const labels = {
  id: "Feature ID",
  area: "Area",
  feature: "Feature",
  commands: "Commands",
  story: "User Story",
  expectedBehavior: "Expected Behavior",
  keyFlags: "Key Flags",
  codeRef: "Code Ref",
  tests: "Coverage / Tests",
  coverageStatus: "Coverage Status",
  storyStatus: "Story Status",
  testStatus: "Test Status",
  defectStatus: "Defect Status",
  fixCommit: "Fix Commit",
  retestStatus: "Retest Status",
  notes: "Notes",
};

const statusLists = {
  coverageStatus: ["Covered", "Partially covered", "Not covered"],
  storyStatus: ["Cataloged", "In review", "Updated"],
  testStatus: ["Pending", "Passed", "Failed", "Blocked"],
  defectStatus: ["None logged", "Open", "Fixed", "Won't fix"],
  retestStatus: ["Pending", "Passed", "Failed", "Not needed"],
};

function a1Column(index) {
  let n = index + 1;
  let result = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function applyHeaderStyle(range) {
  range.format.fill = { color: "#DCEBFF" };
  range.format.font = { bold: true, color: "#12304A", name: "Aptos" };
  range.format.wrapText = true;
  range.format.horizontalAlignment = "Center";
  range.format.verticalAlignment = "Center";
  range.format.borders = { preset: "all", style: "thin", color: "#B8CBE1" };
}

function applyBodyStyle(range) {
  range.format.font = { name: "Aptos", size: 10 };
  range.format.wrapText = true;
  range.format.verticalAlignment = "Top";
  range.format.borders = { preset: "inside", style: "thin", color: "#E2E8F0" };
}

function setColumnWidths(sheet) {
  const widths = [
    11, 12, 24, 24, 42, 50, 22, 22, 36, 18, 16, 14, 16, 14, 14, 26,
  ];
  widths.forEach((width, index) => {
    sheet.getRange(`${a1Column(index)}1`).format.columnWidth = width;
  });
}

function addValidation(sheet, columnIndex, values, rowCount) {
  const col = a1Column(columnIndex);
  sheet.dataValidations.add({
    range: `${col}2:${col}${rowCount}`,
    rule: { type: "list", values },
  });
}

async function buildWorkbook() {
  await fs.mkdir(outputDir, { recursive: true });

  const workbook = Workbook.create();
  const summary = workbook.worksheets.add("Summary");
  const matrix = workbook.worksheets.add("Feature Matrix");
  const errorLog = workbook.worksheets.add("Error Log");

  summary.showGridLines = false;
  matrix.showGridLines = false;
  errorLog.showGridLines = false;

  const matrixHeaders = columns.map((column) => labels[column]);
  const matrixRows = featureStories.map((story) => columns.map((column) => story[column] ?? ""));
  const lastFeatureRow = matrixRows.length + 1;

  matrix.getRange(`A1:${a1Column(columns.length - 1)}1`).values = [matrixHeaders];
  matrix.getRange(`A2:${a1Column(columns.length - 1)}${lastFeatureRow}`).values = matrixRows;
  applyHeaderStyle(matrix.getRange(`A1:${a1Column(columns.length - 1)}1`));
  applyBodyStyle(matrix.getRange(`A2:${a1Column(columns.length - 1)}${lastFeatureRow}`));
  matrix.freezePanes.freezeRows(1);
  setColumnWidths(matrix);

  addValidation(matrix, 9, statusLists.coverageStatus, lastFeatureRow);
  addValidation(matrix, 10, statusLists.storyStatus, lastFeatureRow);
  addValidation(matrix, 11, statusLists.testStatus, lastFeatureRow);
  addValidation(matrix, 12, statusLists.defectStatus, lastFeatureRow);
  addValidation(matrix, 14, statusLists.retestStatus, lastFeatureRow);

  summary.getRange("A1:H1").merge();
  summary.getRange("A1").values = [["nowhere-cli Feature Audit"]];
  summary.getRange("A2:H2").merge();
  summary.getRange("A2").values = [[
    "Canonical spreadsheet for user stories, expected behavior, coverage status, defect logging, fix tracking, and post-fix retest state.",
  ]];
  summary.getRange("A1:H1").format.fill = { color: "#DCEBFF" };
  summary.getRange("A2:H2").format.fill = { color: "#EFF6FF" };
  summary.getRange("A1:H1").format.font = { color: "#0F172A", bold: true, name: "Aptos Display", size: 16 };
  summary.getRange("A2").format.font = { color: "#334155", bold: false, name: "Aptos", size: 10 };
  summary.getRange("A1:H2").format.wrapText = true;
  summary.getRange("A1:H2").format.borders = { preset: "outside", style: "thin", color: "#B8CBE1" };
  summary.getRange("A4:B4").values = [["Metric", "Value"]];
  summary.getRange("D4:E4").values = [["Metric", "Value"]];
  applyHeaderStyle(summary.getRange("A4:B4"));
  applyHeaderStyle(summary.getRange("D4:E4"));

  summary.getRange("A5:A12").values = [[
    "Total stories"
  ], [
    "Covered"
  ], [
    "Partially covered"
  ], [
    "Not covered"
  ], [
    "Pending tests"
  ], [
    "Passed tests"
  ], [
    "Failed tests"
  ], [
    "Open defects"
  ]];
  summary.getRange("B5:B12").formulas = [[
    `=COUNTA('Feature Matrix'!$A$2:$A$${lastFeatureRow})`
  ], [
    `=COUNTIF('Feature Matrix'!$J$2:$J$${lastFeatureRow},"Covered")`
  ], [
    `=COUNTIF('Feature Matrix'!$J$2:$J$${lastFeatureRow},"Partially covered")`
  ], [
    `=COUNTIF('Feature Matrix'!$J$2:$J$${lastFeatureRow},"Not covered")`
  ], [
    `=COUNTIF('Feature Matrix'!$L$2:$L$${lastFeatureRow},"Pending")`
  ], [
    `=COUNTIF('Feature Matrix'!$L$2:$L$${lastFeatureRow},"Passed")`
  ], [
    `=COUNTIF('Feature Matrix'!$L$2:$L$${lastFeatureRow},"Failed")`
  ], [
    `=COUNTIF('Feature Matrix'!$M$2:$M$${lastFeatureRow},"Open")`
  ]];

  summary.getRange("D5:D11").values = [[
    "Areas"
  ], [
    "Generic / signer / create"
  ], [
    "Store"
  ], [
    "Petition"
  ], [
    "Fundraiser / message"
  ], [
    "Forum"
  ], [
    "Cross-cutting"
  ]];
  summary.getRange("E5:E11").formulas = [[
    `=COUNTA(UNIQUE('Feature Matrix'!$B$2:$B$${lastFeatureRow}))`
  ], [
    `=COUNTIF('Feature Matrix'!$B$2:$B$${lastFeatureRow},"generic")+COUNTIF('Feature Matrix'!$B$2:$B$${lastFeatureRow},"signer")+COUNTIF('Feature Matrix'!$B$2:$B$${lastFeatureRow},"create")`
  ], [
    `=COUNTIF('Feature Matrix'!$B$2:$B$${lastFeatureRow},"store")`
  ], [
    `=COUNTIF('Feature Matrix'!$B$2:$B$${lastFeatureRow},"petition")`
  ], [
    `=COUNTIF('Feature Matrix'!$B$2:$B$${lastFeatureRow},"fundraiser")+COUNTIF('Feature Matrix'!$B$2:$B$${lastFeatureRow},"message")`
  ], [
    `=COUNTIF('Feature Matrix'!$B$2:$B$${lastFeatureRow},"forum")`
  ], [
    `=COUNTIF('Feature Matrix'!$B$2:$B$${lastFeatureRow},"cross-cutting")`
  ]];

  applyBodyStyle(summary.getRange("A5:E12"));
  summary.getRange("A14:H14").merge();
  summary.getRange("A14").values = [[
    "Workflow: catalog from code -> run story-based tests -> log defects in Error Log -> fix with TDD and commits -> update Feature Matrix test and retest statuses.",
  ]];
  summary.getRange("A14:H14").format.fill = { color: "#F8FAFC" };
  summary.getRange("A14:H14").format.font = { color: "#334155", italic: true, name: "Aptos", size: 10 };
  summary.getRange("A14:H14").format.wrapText = true;
  summary.getRange("A1").format.columnWidth = 28;
  summary.getRange("B1").format.columnWidth = 12;
  summary.getRange("D1").format.columnWidth = 28;
  summary.getRange("E1").format.columnWidth = 12;

  const errorHeaderLastCol = a1Column(errorLogColumns.length - 1);
  errorLog.getRange(`A1:${errorHeaderLastCol}1`).values = [errorLogColumns];
  applyHeaderStyle(errorLog.getRange(`A1:${errorHeaderLastCol}1`));
  if (errorLogEntries.length > 0) {
    const errorRows = errorLogEntries.map((entry) => errorLogColumns.map((column) => entry[column] ?? ""));
    const errorLastRow = errorRows.length + 1;
    errorLog.getRange(`A2:${errorHeaderLastCol}${errorLastRow}`).values = errorRows;
    applyBodyStyle(errorLog.getRange(`A2:${errorHeaderLastCol}${errorLastRow}`));
  }
  errorLog.freezePanes.freezeRows(1);
  errorLog.getRange("A1").format.columnWidth = 10;
  errorLog.getRange("B1").format.columnWidth = 11;
  errorLog.getRange("C1").format.columnWidth = 12;
  errorLog.getRange("D1").format.columnWidth = 20;
  errorLog.getRange("E1").format.columnWidth = 36;
  errorLog.getRange("F1").format.columnWidth = 36;
  errorLog.getRange("G1").format.columnWidth = 30;
  errorLog.getRange("H1").format.columnWidth = 12;
  errorLog.getRange("I1").format.columnWidth = 14;
  errorLog.getRange("J1").format.columnWidth = 14;
  errorLog.getRange("K1").format.columnWidth = 14;
  errorLog.getRange("L1").format.columnWidth = 28;
  errorLog.dataValidations.add({
    range: "H2:H400",
    rule: { type: "list", values: ["P0", "P1", "P2", "P3"] },
  });
  errorLog.dataValidations.add({
    range: "I2:I400",
    rule: { type: "list", values: ["Open", "Fixed", "Won't fix", "Blocked"] },
  });
  errorLog.dataValidations.add({
    range: "K2:K400",
    rule: { type: "list", values: ["Pending", "Passed", "Failed", "Not needed"] },
  });

  const exported = await SpreadsheetFile.exportXlsx(workbook);
  await exported.save(workbookPath);

  const summaryPreview = await workbook.render({ sheetName: "Summary", range: "A1:H14", scale: 2 });
  const matrixPreview = await workbook.render({ sheetName: "Feature Matrix", range: `A1:P18`, scale: 1.5 });
  const errorPreview = await workbook.render({ sheetName: "Error Log", range: "A1:L8", scale: 1.5 });

  await fs.writeFile(path.join(outputDir, "summary-preview.png"), new Uint8Array(await summaryPreview.arrayBuffer()));
  await fs.writeFile(path.join(outputDir, "matrix-preview.png"), new Uint8Array(await matrixPreview.arrayBuffer()));
  await fs.writeFile(path.join(outputDir, "error-preview.png"), new Uint8Array(await errorPreview.arrayBuffer()));

  const inspect = await workbook.inspect({
    kind: "table",
    sheetId: "Feature Matrix",
    range: "A1:P8",
    include: "values,formulas",
    tableMaxRows: 8,
    tableMaxCols: 16,
  });
  const errors = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 50 },
    summary: "formula error scan",
  });

  const verification = {
    workbookPath,
    previews: {
      summary: path.join(outputDir, "summary-preview.png"),
      matrix: path.join(outputDir, "matrix-preview.png"),
      errorLog: path.join(outputDir, "error-preview.png"),
    },
    inspect: inspect.ndjson,
    formulaErrors: errors.ndjson,
  };

  await fs.writeFile(path.join(runDir, "workbook-verification.json"), `${JSON.stringify(verification, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
}

buildWorkbook().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
