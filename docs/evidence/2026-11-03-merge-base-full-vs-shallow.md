# Full-history vs shallow merge-base diffs on real consumer PRs (2026-11-03)

Evidence for [cms-platform#541](https://github.com/Adam-S-Daniel/cms-platform/issues/541):
does the `fetch-depth: 2` checkout plus `e2e/ensure-merge-base.js` (v0.1.126,
[#565](https://github.com/Adam-S-Daniel/cms-platform/pull/565)) give the three
salience jobs exactly the changed-file set a full-history checkout gives, on
the consumers' real histories?

## Method

The three jobs (`visual-regression.yml` `detect`, `parity-preview.yml`
`parity-probe`, `preview-media.yml` `media-probe`) decide their outcome from
one input: `git diff --name-only -z --no-renames origin/<base>...HEAD` on the
PR merge commit. Everything after that is a pure function of the file list
(`isSalient()` in `e2e/visual-regression-salient.js`, the media `grep -Ez`
pattern, `selectParityPreviewSpecs()` in `e2e/select-specs.js`). The preview
build and deploy jobs were not changed by #565 and do not read this diff. So
identical file lists mean identical salience, parity selection and media
outcomes.

For each PR, against a `git clone --mirror` of the consumer (taken
2026-11-03; adamdaniel.ai `main` at `da593038`, jodidaniel.com `main` at
`3eb6385`), the script below:

1. rebuilds the merge commit GitHub tests (`base.sha` + `head.sha` from the
   pulls API) with `git merge-tree`, skipping a PR that conflicts;
2. diffs it against the base with full history (the old `fetch-depth: 0`
   behavior);
3. checks it out the way `actions/checkout` does on `pull_request`
   (`--depth=2` of the merge ref), runs `ensure-merge-base.js --base <base>`
   from cms-platform `main` at `02253f4`, and diffs again;
4. compares the two NUL-delimited lists, and the three classifier outputs.

Two samples per site:

- **Recent:** every merged PR in the last 100 closed PRs into `main`, at its
  real `base.sha`. adamdaniel.ai #4518-#4620 (95 PRs, 67 of them `cms/*`
  content PRs), jodidaniel.com #363-#469 (86 PRs).
- **Stale:** every 100th (adamdaniel.ai) or 10th (jodidaniel.com) PR head
  since the repo began, merged into today's `main`. This is the long-lived
  branch case: the merge base is far behind both tips, so the helper has to
  deepen. adamdaniel.ai squash-merges, so its old heads diverge from `main`
  and produce real diffs; jodidaniel.com's old heads are mostly ancestors of
  `main`, so its stale diffs are empty and test only the deepening.

## Results

| Sample | PRs compared | Skipped (conflict) | File lists equal | Visual / media / parity outcome equal | Visual-salient | Media-salient | Deepen rounds |
|---|---:|---:|---:|---:|---:|---:|---|
| adamdaniel.ai recent | 95 | 0 | 95 | 95 | 4 | 10 | 1 each |
| jodidaniel.com recent | 86 | 0 | 86 | 86 | 34 | 1 | 1 each |
| adamdaniel.ai stale | 38 | 7 | 38 | 38 | 1 | 4 | 1-6 (up to 5,381 commits fetched) |
| jodidaniel.com stale | 20 | 23 | 20 | 20 | 0 | 0 | 0-3 |

**239 comparisons, zero differences** in the file list or any classifier
outcome. No run fell back to `--unshallow`; none failed.

Not covered: the merge commit is rebuilt locally rather than fetched from
GitHub (GitHub keeps `refs/pull/N/merge` only while a PR is open); a PR whose
rebuilt merge conflicts is skipped; no workflow was re-run, so job timings are
the ones in [CONTENT-PUBLISH-LATENCY.md](../CONTENT-PUBLISH-LATENCY.md#defects-found-that-outlive-the-shelving).

## Script

`compare.sh <mirror.git> <prs.tsv> <out.tsv>`, where each `prs.tsv` line is
`number<TAB>base_sha<TAB>head_sha<TAB>label<TAB>merged_at`. The recent list
came from
`gh api "repos/<owner>/<repo>/pulls?state=closed&base=main&per_page=100&sort=updated&direction=desc" --jq '.[]|select(.merged_at!=null)|[.number,.base.sha,.head.sha,.head.ref,.merged_at]|@tsv'`.

```bash
#!/usr/bin/env bash
# compare.sh <mirror.git> <prs.tsv> <out.tsv>
# For each merged PR: rebuild the merge commit GitHub tested (base.sha + head.sha),
# diff it against the base with full history, then again from a depth-2 checkout
# deepened by ensure-merge-base.js, and compare the NUL-delimited file lists.
set -u
mirror=$(realpath "$1"); prs=$2; out=$3
H=$(realpath "${HARNESS:-e2e}")   # the platform e2e/ directory
tmp=$(mktemp -d)
printf 'pr\tfiles_full\tfiles_shallow\tequal\trounds\tcommits_shallow\tvisual_full\tvisual_shallow\tmedia_full\tmedia_shallow\tparity_full\tparity_shallow\n' > "$out"
while IFS=$'\t' read -r pr base head ref merged; do
  git -C "$mirror" cat-file -e "$head^{commit}" 2>/dev/null || { echo "$pr skip: head gone" >&2; continue; }
  tree=$(git -C "$mirror" merge-tree --write-tree "$base" "$head" 2>/dev/null) || { echo "$pr skip: conflict" >&2; continue; }
  tree=$(head -1 <<<"$tree")
  m=$(GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=x@example.com GIT_COMMITTER_NAME=x GIT_COMMITTER_EMAIL=x@example.com GIT_AUTHOR_DATE="1700000000 +0000" GIT_COMMITTER_DATE="1700000000 +0000" git -C "$mirror" commit-tree "$tree" -p "$base" -p "$head" -m "cmp $pr")
  git -C "$mirror" update-ref "refs/heads/cmp-base-$pr" "$base"
  git -C "$mirror" update-ref "refs/pull/$pr/cmpmerge" "$m"
  git -C "$mirror" diff --name-only -z --no-renames "cmp-base-$pr...$m" > "$tmp/full"
  w="$tmp/w$pr"; git init -q "$w"; git -C "$w" remote add origin "file://$mirror"
  git -C "$w" fetch -q --no-tags --depth=2 origin "+refs/pull/$pr/cmpmerge:refs/remotes/pull/$pr/merge"
  git -C "$w" checkout -q --detach "refs/remotes/pull/$pr/merge"
  (cd "$w" && node "$H/ensure-merge-base.js" --base "cmp-base-$pr" >/dev/null 2>"$tmp/log") || { echo "$pr ensure-merge-base FAILED: $(cat $tmp/log)" >&2; continue; }
  rounds=$(grep -o 'after [0-9]* deepen' "$tmp/log" | grep -o '[0-9]*' || echo "?")
  git -C "$w" diff --name-only -z --no-renames "origin/cmp-base-$pr...HEAD" > "$tmp/shallow"
  commits=$(git -C "$w" rev-list --count --all)
  node -e '
    const fs=require("fs"); const H=process.argv[1];
    const v=require(H+"/visual-regression-salient.js"); const s=require(H+"/select-specs.js");
    const media=/^(assets\/images\/uploads\/|admin\/config(-local)?\.yml$|_config\.yml$|_layouts\/(post|canary)\.html$)/;
    const r=(f)=>{const l=v.parseNulPaths(fs.readFileSync(f,"utf8")); const p=s.selectParityPreviewSpecs(l);
      return {n:l.length, key:JSON.stringify(l), vis:v.isSalient(l), med:l.some(x=>media.test(x)), par:JSON.stringify(p.files||p)};};
    const a=r(process.argv[2]), b=r(process.argv[3]);
    console.log([process.argv[4],a.n,b.n,a.key===b.key,process.argv[5],process.argv[6],a.vis,b.vis,a.med,b.med,a.par===b.par?"same":a.par,b.par===a.par?"same":b.par].join("\t"));
  ' "$H" "$tmp/full" "$tmp/shallow" "$pr" "$rounds" "$commits" >> "$out"
  rm -rf "$w"; git -C "$mirror" update-ref -d "refs/heads/cmp-base-$pr"; git -C "$mirror" update-ref -d "refs/pull/$pr/cmpmerge"
done < "$prs"
rm -rf "$tmp"
```
