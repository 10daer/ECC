/**
 * Check Coverage Tool
 *
 * Custom OpenCode tool to analyze test coverage and report on gaps.
 * Supports common coverage report formats.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import * as path from "path"
import * as fs from "fs"

const checkCoverageTool: ToolDefinition = tool({
  description:
    "Check test coverage against a threshold and identify files with low coverage. Reads coverage reports from common locations.",
  args: {
    threshold: tool.schema
      .number()
      .optional()
      .describe("Minimum coverage percentage required (default: 80)"),
    showUncovered: tool.schema
      .boolean()
      .optional()
      .describe("Show list of uncovered files (default: true)"),
    format: tool.schema
      .enum(["summary", "detailed", "json"])
      .optional()
      .describe("Output format (default: summary)"),
  },
  async execute(args, context) {
    const threshold = args.threshold ?? 80
    const showUncovered = args.showUncovered ?? true
    const format = args.format ?? "summary"
    const cwd = context.worktree || context.directory

    // Look for coverage reports
    const coveragePaths = [
      "coverage/coverage-summary.json",
      "coverage/lcov-report/index.html",
      "coverage/coverage-final.json",
      ".nyc_output/coverage.json",
    ]

    let coverageData: CoverageSummary | null = null
    let coverageFile: string | null = null

    for (const coveragePath of coveragePaths) {
      const fullPath = path.join(cwd, coveragePath)
      if (fs.existsSync(fullPath) && coveragePath.endsWith(".json")) {
        try {
          const content = JSON.parse(fs.readFileSync(fullPath, "utf-8"))
          coverageData = parseCoverageData(content)
          coverageFile = coveragePath
          break
        } catch {
          // Continue to next file
        }
      }
    }

    if (!coverageData) {
      return JSON.stringify({
        success: false,
        error: "No coverage report found",
        suggestion:
          "Run tests with coverage first: npm test -- --coverage",
        searchedPaths: coveragePaths,
      })
    }

    const passed = coverageData.total.percentage >= threshold
    const uncoveredFiles = coverageData.files.filter(
      (f) => f.percentage < threshold
    )

    const result: CoverageResult = {
      success: passed,
      threshold,
      coverageFile,
      total: coverageData.total,
      passed,
    }

    if (format === "detailed" || (showUncovered && uncoveredFiles.length > 0)) {
      result.uncoveredFiles = uncoveredFiles.slice(0, 20) // Limit to 20 files
      result.uncoveredCount = uncoveredFiles.length
    }

    if (format === "json") {
      result.rawData = coverageData
    }

    if (!passed) {
      result.suggestion = `Coverage is ${coverageData.total.percentage.toFixed(1)}% which is below the ${threshold}% threshold. Focus on these files:\n${uncoveredFiles
        .slice(0, 5)
        .map((f) => `- ${f.file}: ${f.percentage.toFixed(1)}%`)
        .join("\n")}`
    }

    return JSON.stringify(result)
  },
})

export default checkCoverageTool

interface CoverageSummary {
  total: {
    lines: number
    covered: number
    percentage: number
  }
  files: Array<{
    file: string
    lines: number
    covered: number
    percentage: number
  }>
}

interface CoverageResult {
  success: boolean
  threshold: number
  coverageFile: string | null
  total: CoverageSummary["total"]
  passed: boolean
  uncoveredFiles?: CoverageSummary["files"]
  uncoveredCount?: number
  rawData?: CoverageSummary
  suggestion?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function lineMetrics(lines: number, covered: number): CoverageSummary["total"] {
  if (!Number.isInteger(lines) || !Number.isInteger(covered) || lines < 0 || covered < 0 || covered > lines) {
    throw new Error("Invalid coverage line metrics")
  }
  return { lines, covered, percentage: lines > 0 ? (covered / lines) * 100 : 100 }
}

function summaryMetrics(value: unknown): CoverageSummary["total"] {
  if (!isRecord(value) || !isRecord(value.lines)
    || typeof value.lines.total !== "number" || typeof value.lines.covered !== "number") {
    throw new Error("Invalid coverage summary")
  }
  return lineMetrics(value.lines.total, value.lines.covered)
}

function rawMetrics(value: unknown): CoverageSummary["total"] {
  if (!isRecord(value) || !isRecord(value.statementMap) || !isRecord(value.s)) {
    throw new Error("Unsupported coverage report")
  }
  const hitsByLine = new Map<number, number>()
  for (const [statementId, hits] of Object.entries(value.s)) {
    if (typeof hits !== "number" || !Number.isFinite(hits) || hits < 0) {
      throw new Error("Invalid coverage statement hits")
    }
    const location = value.statementMap[statementId]
    // Istanbul's getLineCoverage uses statement start lines and the maximum
    // hit count when multiple statements share a line, rather than end ranges.
    if (location === undefined) continue
    if (!isRecord(location) || !isRecord(location.start)
      || typeof location.start.line !== "number" || !Number.isInteger(location.start.line) || location.start.line < 1) {
      throw new Error("Invalid coverage statement location")
    }
    const line = location.start.line
    hitsByLine.set(line, Math.max(hitsByLine.get(line) || 0, hits))
  }
  return lineMetrics(hitsByLine.size, [...hitsByLine.values()].filter(hits => hits > 0).length)
}

function parseCoverageData(data: unknown): CoverageSummary {
  if (!isRecord(data)) throw new Error("Unsupported coverage report")
  const files: CoverageSummary["files"] = []
  if ("total" in data) {
    for (const [file, value] of Object.entries(data)) {
      if (file !== "total") files.push({ file, ...summaryMetrics(value) })
    }
    return { total: summaryMetrics(data.total), files }
  }
  if (Object.keys(data).length === 0) throw new Error("Empty coverage report")
  for (const [file, value] of Object.entries(data)) files.push({ file, ...rawMetrics(value) })
  return {
    total: lineMetrics(
      files.reduce((sum, file) => sum + file.lines, 0),
      files.reduce((sum, file) => sum + file.covered, 0)
    ),
    files,
  }
}
