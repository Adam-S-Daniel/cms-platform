# frozen_string_literal: true
# Entry point loaded when the gem is in the site's :jekyll_plugins group.
# Registers the platform's Jekyll plugins + the Decap config render hook.
require_relative "cms-platform-theme/auto_tag_pages"
require_relative "cms-platform-theme/cachebust_filter"
require_relative "cms-platform-theme/exclude_e2e_posts"
require_relative "cms-platform-theme/normalize_empty_slug"
require_relative "cms-platform-theme/tag_feeds"
require_relative "cms-platform-theme/decap_config_hook"
