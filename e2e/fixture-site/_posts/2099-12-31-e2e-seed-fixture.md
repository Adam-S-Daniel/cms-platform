---
title: E2E Seed Fixture
date: 2099-12-31 00:00:00 +0000
tags: [Seed Fixture Tag]
published: true
---

This post has an `e2e-` slug and NO `test_fixture` flag and NO `sitemap: false`
— exactly the shape a Decap "+ New Post" UI create produces for an ephemeral
prod-loop fixture. The theme's `exclude_e2e_posts.rb` hook MUST stamp
`feed_exclude: true` + `sitemap: false` on it at build, so it stays out of the
feed / sitemap / homepage / blog index while still serving at /blog/e2e-seed-fixture/.
