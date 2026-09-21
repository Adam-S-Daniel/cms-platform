---
title: Introducing GHA-bench
slug: introducing-gha-bench
date: 2026-05-13 08:51:00 -0400
excerpt: GHA-bench is a benchmark and a set of evals for how well different
  coding agents author and test GitHub Actions using different languages.
featured_image: /assets/images/uploads/img_9581.png
published: true
---
[GHA-bench](https://github.com/Adam-S-Daniel/GHA-bench) is a benchmark and a set of evals for how well different coding agents author and test GitHub Actions.

## How it works

Agents are given a set of tasks. See the [full writeup](/blog/gha-bench-writeup/) for details.

Adjust the sliders according to your priorities.

<!-- html-embed:start -->
<div class="post-embed">
<div class="bws-widget">
  <div class="bws-sliders">
    <div class="bws-slider-row">
      <label class="bws-label" for="bws-duration">Duration</label>
      <input class="bws-range" type="range" id="bws-duration" min="0" max="100" step="0.5" value="17.5">
    </div>
  </div>
</div>
<script>
  console.log("widget script");
</script>
</div>
<!-- html-embed:end -->

See also this [related post](/blog/other-post/) and an image ![diagram](/assets/images/uploads/diagram.png).

Also see <img src="/assets/images/uploads/inline.png" alt="inline"> and <a href="/blog/another/">another link</a>.

Untouched: [external](https://example.com/x) and ![proto-relative](//cdn.example.com/y.png) and <a href="//cdn.example.com/z">cdn</a>.
