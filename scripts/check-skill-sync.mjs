/**
 * Fail when the development skill copy and the packaged skill copy drift.
 * Development copy: .agents/skills
 * Packaged copy:    desktop/shell/apps/desktop/resources/skills
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DEV_SKILLS = fileURLToPath(new URL('../.agents/skills', import.meta.url))
export const PACKAGED_SKILLS = fileURLToPath(
  new URL('../desktop/shell/apps/desktop/resources/skills', import.meta.url),
)

const IGNORED_NAMES = new Set(['__pycache__', '.DS_Store', 'node_modules'])
const IGNORED_SUFFIXES = ['.pyc']

function isIgnored(name) {
  return IGNORED_NAMES.has(name) || IGNORED_SUFFIXES.some(suffix => name.endsWith(suffix))
}

function walk(root, current = root, files = new Map()) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (isIgnored(entry.name)) continue
    const full = join(current, entry.name)
    if (entry.isDirectory()) {
      walk(root, full, files)
      continue
    }
    if (!entry.isFile()) continue
    const key = relative(root, full).split(sep).join('/')
    files.set(key, createHash('sha256').update(readFileSync(full)).digest('hex'))
  }
  return files
}

/**
 * Compare both skill trees by relative path and content hash.
 * @param devRoot - development copy root.
 * @param packagedRoot - packaged copy root.
 * @returns drift descriptions and the number of development files.
 */
export function compareSkillTrees(devRoot = DEV_SKILLS, packagedRoot = PACKAGED_SKILLS) {
  const dev = walk(devRoot)
  const packaged = walk(packagedRoot)
  const problems = []
  for (const [path, hash] of dev) {
    if (!packaged.has(path)) problems.push(`missing from packaged skills: ${path}`)
    else if (packaged.get(path) !== hash) problems.push(`differs: ${path}`)
  }
  for (const path of packaged.keys()) {
    if (!dev.has(path)) problems.push(`missing from .agents/skills: ${path}`)
  }
  return { problems, count: dev.size }
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url

if (invokedDirectly) {
  for (const root of [DEV_SKILLS, PACKAGED_SKILLS]) {
    if (!existsSync(root)) {
      console.error(`missing skill directory: ${root}`)
      process.exit(1)
    }
  }
  const { problems, count } = compareSkillTrees()
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    console.error('技能的两份副本必须一致：改完一份后同步另一份，再打包。')
    process.exit(1)
  }
  console.log(`skill sync ok, ${count} files.`)
}
