# frozen_string_literal: true
# Plain-ruby unit test for the base-collection opt-out filter shared by
# decap_config_hook.rb and scripts/render-decap-config.rb. Run:
#   ruby theme/spec/base_collections_filter_test.rb
#
# `cms.base_collections` is a KEEP-LIST of the platform's built-in collection
# names (posts/tags/projects/pages/e2e); UNSET keeps them all. Each unwanted
# top-level collection block is deleted from the rendered config at 2-space
# indent, through to the next top-level `- name:` or EOF — nested fields are
# deeper-indented so they must survive. This locks that regex contract; if the
# pattern drifts (e.g. matches nested `- name:` or eats a survivor's fields),
# /admin collections silently break for every consumer that sets the option.

require "minitest/autorun"
require "yaml"

class BaseCollectionsFilterTest < Minitest::Test
  BASE_NAMES = %w[posts tags projects pages e2e].freeze

  CONFIG = <<~YAML
    backend:
      name: github
    collections:
      - name: posts
        label: Posts
        fields:
          - name: title
            widget: string
          - name: body
            widget: markdown
      - name: tags
        label: Tags
        fields:
          - name: title
            widget: string
      - name: e2e
        label: E2E
        fields:
          - name: title
            widget: string
      - name: site_content
        label: Home Page
        files:
          - name: home
            file: _data/home.yml
            fields:
              - name: title
                widget: string
  YAML

  # Mirrors the filter inlined in both renderers.
  def filter(text, keep)
    return text if keep.nil?
    keepset = Array(keep).map(&:to_s)
    (BASE_NAMES - keepset).each do |n|
      text = text.sub(/^  - name: #{Regexp.escape(n)}\n.*?(?=^  - name: |\z)/m, "")
    end
    text
  end

  def top_level_collections(text)
    YAML.load(text).fetch("collections").map { |c| c["name"] }
  end

  def test_nil_keep_changes_nothing
    out = filter(CONFIG.dup, nil)
    assert_equal CONFIG, out
  end

  def test_empty_keep_hides_every_base_collection_but_keeps_site
    out = filter(CONFIG.dup, [])
    assert_equal %w[site_content], top_level_collections(out)
  end

  def test_partial_keep_retains_only_listed_base_collections
    out = filter(CONFIG.dup, %w[posts])
    assert_equal %w[posts site_content], top_level_collections(out)
  end

  def test_survivors_keep_their_nested_fields_and_yaml_is_valid
    out = filter(CONFIG.dup, [])
    parsed = YAML.load(out)
    home = parsed["collections"].first
    assert_equal "site_content", home["name"]
    assert_equal %w[title], home["files"].first["fields"].map { |f| f["name"] }
  end

  def test_does_not_match_deeper_indented_field_named_like_a_collection
    # The SURVIVOR (site_content) has a FIELD literally named `posts` at field
    # indent. Hiding the top-level base `posts` collection must NOT touch it.
    cfg = +"collections:\n"
    cfg << "  - name: posts\n    fields:\n      - name: title\n        widget: string\n"
    cfg << "  - name: site_content\n    fields:\n      - name: posts\n        widget: string\n"
    out = filter(cfg, [])
    assert_equal %w[site_content], top_level_collections(out)
    fields = YAML.load(out)["collections"].first["fields"].map { |f| f["name"] }
    assert_includes fields, "posts", "the survivor's field named `posts` must survive"
  end
end
