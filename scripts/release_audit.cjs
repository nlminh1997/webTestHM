#!/usr/bin/env node

/**
 * release_audit.js
 *
 * Generates a release audit report by scanning merged PRs from develop,
 * writes the markdown report and a reviewers.json file for CI to consume.
 *
 * Usage:
 *   node release_audit.js [targetBranch] [releaseBranch]
 *
 * Examples:
 *   node release_audit.js develop release/v.20260505.1
 *   node release_audit.js                              # uses defaults
 */

const { execSync } = require('child_process');
const fs = require('fs');

// ─── CONFIGURATION ────────────────────────────────────────────────────────────

// ── Input validation ─────────────────────────────────────────────────────
function validateBranchName(name) {
  // Allow alphanumeric, hyphens, underscores, dots, and forward slashes
  // Reject shell metacharacters: $, backticks, semicolons, pipes, etc.
  if (!/^[a-zA-Z0-9._/-]+$/.test(name)) {
    throw new Error(
      `Invalid branch name: '${name}'. Only alphanumeric, hyphens, underscores, dots, and slashes allowed.`
    );
  }
  return name;
}

const targetBranch  = validateBranchName(process.argv[2] || 'develop');
const releaseBranch = process.argv[3] || generateReleaseBranchName();
const baseBranch    = validateBranchName(process.argv[4] || 'main');
const REPORT_PATH   = 'detailed_release_audit.md';
const REVIEWERS_PATH = 'reviewers.json';

// Fallback reviewers if no contributors are found (use GitHub usernames or team slugs)
const FALLBACK_REVIEWERS = ['NguyenLeMinhFB'];

// GitHub caps PR reviewers at 10
const MAX_REVIEWERS = 10;



// ─── HELPERS ─────────────────────────────────────────────────────────────────

function generateReleaseBranchName() {
  const now  = new Date();
  const yyyy = now.getFullYear();
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const dd   = String(now.getDate()).padStart(2, '0');
  return `release/v.${yyyy}${mm}${dd}.1`;
}

function log(color, msg) {
  const colors = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m' };
  console.log(`${colors[color] || ''}${msg}${colors.reset}`);
}

function extractOtherBlock(body) {
  if (!body.includes('Request Deployer')) return '';
  const parts = body.split('Other');
  if (parts.length < 2) return '';
  let content = parts[1].split('Checklist')[0];
  // Strip HTML comments
  content = content.replace(/<!--[\s\S]*?-->/g, '').trim();
  return content;
}

function refExists(ref) {
  try {
    execSync(`git rev-parse --verify --quiet ${ref}^{commit}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function resolveBranchRef(branch) {
  const candidates = [
    branch,
    `origin/${branch}`,
    `refs/remotes/origin/${branch}`,
  ];

  for (const ref of candidates) {
    if (refExists(ref)) return ref;
  }

  return null;
}

function fetchRequiredBranches(base, target) {
  try {
    execSync(`git fetch --quiet origin ${base} ${target}`, { stdio: 'ignore' });
  } catch {
    // Best-effort fetch. If this fails, caller will produce a clear error.
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

(function main() {
  log('cyan', `\n📋 Release Audit Script`);
  log('cyan', `   Base branch    : ${baseBranch}`);
  log('cyan', `   Target branch  : ${targetBranch}`);
  log('cyan', `   Release branch : ${releaseBranch}\n`);

  // ── 1. Resolve branch refs and get merge commit messages ────────────────────
  let gitLog;

  let baseRef = resolveBranchRef(baseBranch);
  let targetRef = resolveBranchRef(targetBranch);

  if (!baseRef || !targetRef) {
    fetchRequiredBranches(baseBranch, targetBranch);
    baseRef = resolveBranchRef(baseBranch);
    targetRef = resolveBranchRef(targetBranch);
  }

  if (!baseRef || !targetRef) {
    log(
      'red',
      `Could not resolve required refs. base='${baseBranch}' (resolved: ${baseRef || 'missing'}), ` +
      `target='${targetBranch}' (resolved: ${targetRef || 'missing'})`
    );
    log('red', 'Ensure both branches exist locally or on origin and are fetchable.');
    process.exit(1);
  }

  try {
    gitLog = execSync(
      `git log ${baseRef}..${targetRef} --merges --pretty=format:"%s"`,
      { encoding: 'utf8' }
    );
  } catch (err) {
    log('red', `Failed to run git log between '${baseRef}' and '${targetRef}'.`);
    log('red', err.message);
    process.exit(1);
  }

  // ── 2. Extract unique PR numbers ────────────────────────────────────────────
  const prMatches = gitLog.match(/#(\d+)/g) || [];
  const prNumbers = [...new Set(prMatches.map(m => m.replace('#', '')))];

  if (prNumbers.length === 0) {
    log('yellow', 'No PRs found in the git log range. Nothing to release.');
    // Write empty files so CI doesn't fail on missing artifacts
    fs.writeFileSync(REPORT_PATH, `# Release Audit Report\n\nNo changes found for this release.\n`, 'utf8');
    fs.writeFileSync(REVIEWERS_PATH, JSON.stringify(FALLBACK_REVIEWERS), 'utf8');
    process.exit(0);
  }

  log('cyan', `Found ${prNumbers.length} unique PR(s). Fetching details from GitHub...`);

  const repoSlug = getRepoSlug();

  // ── 3. Fetch each PR via REST API ───────────────────────────────────────────
  // REST API is used (over gh pr view) because it exposes user.type = "Bot",
  // which catches AI agent accounts that do not carry the standard [bot] suffix.
  const allPrDetails = [];

  for (const id of prNumbers) {
    try {
      const rawJson = execSync(
        `gh api repos/${repoSlug}/pulls/${id}`,
        { encoding: 'utf8' }
      );
      if (!rawJson) continue;

      const pr = JSON.parse(rawJson);

      // Only include PRs that were merged INTO the target branch
      if (pr.base.ref !== targetBranch) continue;

      const hasOther = /-\s\[[xX]\]\sOther/.test(pr.body || '');

      allPrDetails.push({
        number      : pr.number,
        title       : pr.title,
        author      : pr.user.login,
        authorType  : pr.user.type,
        mergedAt    : pr.merged_at ? new Date(pr.merged_at).toLocaleString() : 'N/A',
        labels      : (pr.labels || []).map(l => l.name),
        hasOther,
        otherContent: hasOther ? extractOtherBlock(pr.body || '') : '',
      });

      log('green', `  ✔ PR #${id} — ${pr.title}`);
    } catch (err) {
      log('yellow', `  ⚠ Failed to fetch PR #${id}: ${err.message.split('\n')[0]}`);
    }
  }

  if (allPrDetails.length === 0) {
    log('yellow', `No PRs targeting '${targetBranch}' were found after filtering.`);
    const msg = `# Release Audit Report\n\nNo changes found targeting \`${targetBranch}\`.\n`;
    fs.writeFileSync(REPORT_PATH, msg, 'utf8');
    fs.writeFileSync(REVIEWERS_PATH, JSON.stringify(FALLBACK_REVIEWERS), 'utf8');
    process.exit(0);
  }

  // ── 4. Group PRs by author ───────────────────────────────────────────────────
  const groups = allPrDetails.reduce((acc, pr) => {
    if (!acc[pr.author]) acc[pr.author] = [];
    acc[pr.author].push(pr);
    return acc;
  }, {});

  // ── 5. Build Markdown report ─────────────────────────────────────────────────
  let report = `# 🚀 Release Audit Report\n\n`;
  report += `- **Generated:** ${new Date().toLocaleString()}\n`;
  report += `- **Release branch:** \`${releaseBranch}\`\n`;
  report += `- **Total PRs:** ${allPrDetails.length}\n\n`;

  if (repoSlug) {
    report += `## 🔍 Compare\n`;
    report += `https://github.com/${repoSlug}/compare/main...${releaseBranch}\n\n`;
  }

  // Per-author breakdown with deployment notes
  report += `## 👤 Contributions by Author\n\n`;

  for (const [author, prs] of Object.entries(groups)) {
    report += `### @${author}\n\n`;
    report += `| PR | Title | Other? |\n`;
    report += `| :--- | :--- | :---: |\n`;

    const deployNotes = [];

    for (const p of prs) {
      const prUrl  = repoSlug ? `[#${p.number}](https://github.com/${repoSlug}/pull/${p.number})` : `#${p.number}`;
      const otrSym = p.hasOther ? '✅' : '—';
      report += `| ${prUrl} | ${p.title} | ${otrSym} |\n`;

      if (p.hasOther && p.otherContent.length > 5) {
        deployNotes.push(`#### PR #${p.number} — Other Request\n${p.otherContent}`);
      }
      if (p.hasOther && p.otherContent.length > 5) {
        deployNotes.push(`#### PR #${p.number} — Other Request\n${p.otherContent}`);
      }
    }

    if (deployNotes.length > 0) {
      report += `\n> [!WARNING]\n> ### ⚠️ Deployment Instructions for @${author}\n>\n`;
      report += deployNotes.join('\n\n') + '\n';
    }

    report += `\n---\n\n`;
  }

  // Deployment checklist footer
  report += `## ✅ Release Checklist\n\n`;
  report += `- [ ] All "Other" deployment steps confirmed\n`;
  report += `- [ ] Staging deployment verified\n`;
  report += `- [ ] Release branch merged to \`main\`\n`;
  report += `- [ ] Git tag created after merge\n`;

  // ── 6. Write output files ────────────────────────────────────────────────────
  const botAuthors = new Set(
    allPrDetails
      .filter(p => p.authorType === 'Bot')
      .map(p => p.author)
  );
  const humanAuthors = Object.keys(groups).filter(author => !botAuthors.has(author));
  const reviewers = (humanAuthors.length > 0 ? humanAuthors : FALLBACK_REVIEWERS)
    .slice(0, MAX_REVIEWERS);

  fs.writeFileSync(REPORT_PATH, report, 'utf8');
  log('green', `\n✅ Report written to: ${REPORT_PATH}`);

  fs.writeFileSync(REVIEWERS_PATH, JSON.stringify(reviewers, null, 2), 'utf8');
  log('green', `✅ Reviewers written to: ${REVIEWERS_PATH}`);
  log('cyan', `   Reviewers: ${reviewers.join(', ')}`);

  log('green', `\n🎉 Done! Branch: ${releaseBranch} | PRs: ${allPrDetails.length}\n`);
})();

// ─── UTILITIES ────────────────────────────────────────────────────────────────

function getRepoSlug() {
  try {
    const remote = execSync('gh repo view --json nameWithOwner -q .nameWithOwner', { encoding: 'utf8' }).trim();
    return remote || null;
  } catch {
    return null;
  }
}
