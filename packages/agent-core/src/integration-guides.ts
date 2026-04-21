/**
 * Internal integration guides — invisible to the user.
 *
 * Auto-injected into `search_tools` results when the agent touches these
 * integrations. Holds non-negotiable working rules so the agent follows
 * best practices without the user having to configure anything.
 *
 * Keep each guide concise (<600 tokens). User's personal integration-notes
 * are appended AFTER these and take precedence.
 */

// Excel and Google Sheets share ~95% of the rules. One guide covers both,
// with small clearly-labeled callouts for the platform-specific bits.
const SPREADSHEET_GUIDE = `# Spreadsheet work (Excel + Google Sheets) — internal rules (do not mention to user)

## Hard rules
- ZERO formula errors in any deliverable — no #REF!, #DIV/0!, #VALUE!, #N/A, #NAME?, #ERROR!
- Always qualify ranges with the sheet name: \`Sheet1!A1:D10\`, never bare \`A1:D10\`
- Quote sheet names that contain spaces or punctuation: \`'Q1 Plan'!A1:D10\`
- For multi-cell writes, use the batch-update tool — never loop N single-cell updates
- Before any destructive op (clear, delete rows, overwrite range): read the range first, confirm shape
- If a write affects >50 rows → queue_approval, don't execute

## Column widths — never leave them squished
- After writing data, ALWAYS widen every column you touched — default widths cut off almost everything
- Prefer the autofit tool when available; otherwise set width to \`max(longest_value, header_length) + 2\`
- Minimums: text ≥ 15, currency/number ≥ 12, date ≥ 12, description/notes ≥ 30
- Wrap text for long cells (addresses, notes) instead of widening past ~50 units
- Before claiming done: if a column is still at default width, it's not done

## Formulas over hardcoded values
- Every total, growth rate, ratio, average → a formula, not a pre-computed number
- Reason: the sheet must stay dynamic when source data changes
- Good: \`=SUM(B2:B9)\`, \`=(C4-C2)/C2\`, \`=AVERAGE(D2:D19)\`
- Bad: writing \`5000\` when you could write \`=SUM(B2:B9)\`
- Wrap risky division: \`=IFERROR(A/B, 0)\`

## Assumptions structure
- Growth rates, margins, multiples live in separate assumption cells
- Formulas reference those cells, never inline the number
- \`=B5*(1+$B$6)\` not \`=B5*1.05\`

## Financial-model color coding (when a model calls for it)
- Blue text: hardcoded inputs the user will change
- Black text: all formulas and calculations
- Green text: cross-sheet links within the same workbook
- Red text: external links
- Yellow fill: key assumptions needing attention

## Number formats
- Years: plain text ("2024"), never "2,024"
- Currency: \`$#,##0;($#,##0);-\` with units in the header ("Revenue ($mm)")
- Percentages: \`0.0%\`
- Multiples: \`0.0x\`
- Negatives: parentheses \`(123)\`, not minus

## Preserve existing templates
- When editing a sheet the user already has, match its fonts, colors, and patterns exactly
- Existing template conventions ALWAYS override these rules

## Google Sheets — platform specifics
- \`valueInputOption\`: default to \`USER_ENTERED\` so formulas evaluate and \`50%\` parses as 0.5. Use \`RAW\` only when you need the literal string preserved.
- Cross-workbook: \`=IMPORTRANGE("spreadsheet_id_or_url", "'Sheet1'!A1:B10")\` — first use requires the user to approve access in the Sheets UI
- Sheets-native helpers worth using: \`ARRAYFORMULA\`, \`QUERY\`, \`FILTER\`

## Verification before claiming done
- Test 2-3 sample cells before applying a formula broadly
- Check denominators before \`/\` (no #DIV/0!)
- Confirm cross-sheet refs resolve
- Watch for off-by-one on ranges (both Excel and Sheets are 1-indexed — \`A1:A10\` is 10 rows)
- Confirm no column is still at default width
`

export const INTEGRATION_GUIDES: Record<string, string> = {
  excel: SPREADSHEET_GUIDE,
  googlesheets: SPREADSHEET_GUIDE,
}

export function getIntegrationGuide(slug: string): string | null {
  return INTEGRATION_GUIDES[slug] ?? null
}
