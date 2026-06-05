# frozen_string_literal: true
# Plain-ruby unit test for the field_library $ref resolver shared by BOTH Decap
# render paths (scripts/render-decap-config.rb + decap_config_hook.rb). Run:
#   ruby theme/spec/field_library_resolution_test.rb
#
# A site's seam admin/collections.site.yml may write `$ref: "#/field_library/<name>"`
# where a field (or fields) would go, to REUSE a platform-defined field/widget
# def instead of re-authoring it. The renderers expand every $ref to a DEEP COPY
# of the referenced def BEFORE serializing + splicing the fragment, so Decap
# never sees a $ref. This locks the resolver contract:
#   - a single-field ref (Hash def) resolves to ONE field in place,
#   - a multi-field ref (Array def, e.g. published_pair) SPLICES its fields in,
#   - resolved defs are deep-copied (two refs never share mutable state),
#   - an unknown / malformed $ref FAILS HARD (render must abort, never leak a $ref).

require "minitest/autorun"
require "yaml"
require_relative "../lib/cms-platform-theme/field_library"

class FieldLibraryResolutionTest < Minitest::Test
  FL = CmsPlatformTheme::FieldLibrary

  LIBRARY = {
    "body_markdown" => {
      "name" => "body", "label" => "Body", "widget" => "markdown",
      "modes" => %w[rich_text raw]
    },
    "published_pair" => [
      { "name" => "published", "label" => "Published", "widget" => "boolean", "default" => false },
      { "name" => "publish_date", "label" => "Publish Date", "widget" => "datetime",
        "format" => "YYYY-MM-DD HH:mm:ss ZZ" }
    ],
  }.freeze

  # The real packaged field_library.yml — proves the shipped defs parse and
  # carry the cross-engine date-format contract verbatim from config.base.yml.
  REAL_LIBRARY_PATH = File.expand_path("../admin/field_library.yml", __dir__)

  def collection_with(fields)
    [{ "name" => "demo", "label" => "Demo", "folder" => "_demo", "fields" => fields }]
  end

  def test_resolves_a_single_field_ref_in_place
    frag = collection_with([
      { "name" => "title", "widget" => "string" },
      { "$ref" => "#/field_library/body_markdown" },
    ])
    out = FL.resolve(frag, LIBRARY)
    fields = out.first["fields"]
    assert_equal %w[title body], fields.map { |f| f["name"] }
    body = fields[1]
    assert_equal "markdown", body["widget"]
    assert_equal %w[rich_text raw], body["modes"]
    refute fields.any? { |f| f.key?("$ref") }, "no $ref key may survive resolution"
  end

  def test_resolves_a_multi_field_ref_by_splicing_in_place
    frag = collection_with([
      { "name" => "title", "widget" => "string" },
      { "$ref" => "#/field_library/published_pair" },
      { "name" => "body", "widget" => "markdown" },
    ])
    out = FL.resolve(frag, LIBRARY)
    # published_pair expands to TWO fields spliced between title and body.
    assert_equal %w[title published publish_date body],
                 out.first["fields"].map { |f| f["name"] }
    refute_includes out.first["fields"].map(&:keys).flatten, "$ref"
  end

  def test_resolved_defs_are_deep_copied_no_shared_mutation
    # Two collections each $ref the same single-field def; mutating one resolved
    # field must NOT bleed into the other (proves a deep copy, not a shared ref).
    frag = [
      { "name" => "a", "fields" => [{ "$ref" => "#/field_library/body_markdown" }] },
      { "name" => "b", "fields" => [{ "$ref" => "#/field_library/body_markdown" }] },
    ]
    out = FL.resolve(frag, LIBRARY)
    out[0]["fields"][0]["label"] = "MUTATED"
    out[0]["fields"][0]["modes"] << "wysiwyg"
    assert_equal "Body", out[1]["fields"][0]["label"], "second ref must not see the first's mutation"
    assert_equal %w[rich_text raw], out[1]["fields"][0]["modes"], "nested arrays must be deep-copied too"
    # And the source library is itself untouched.
    assert_equal "Body", LIBRARY["body_markdown"]["label"]
    assert_equal %w[rich_text raw], LIBRARY["body_markdown"]["modes"]
  end

  def test_unknown_ref_fails_hard
    frag = collection_with([{ "$ref" => "#/field_library/does_not_exist" }])
    err = assert_raises(ArgumentError) { FL.resolve(frag, LIBRARY) }
    assert_match(/unresolved \$ref/, err.message)
    assert_match(/does_not_exist/, err.message)
  end

  def test_malformed_pointer_fails_hard
    frag = collection_with([{ "$ref" => "field_library/body_markdown" }]) # missing "#/"
    assert_raises(ArgumentError) { FL.resolve(frag, LIBRARY) }
  end

  def test_no_ref_fragment_is_unchanged
    inline = collection_with([
      { "name" => "title", "label" => "Title", "widget" => "string", "required" => true },
      { "name" => "body", "label" => "Body", "widget" => "markdown" },
    ])
    out = FL.resolve(inline, LIBRARY)
    assert_equal inline, out, "a fragment with no $ref must resolve structurally identical"
  end

  def test_singular_field_ref_resolves_to_one_field
    # `field:` (singular, e.g. a list's nested field) whose value is a $ref.
    frag = collection_with([
      { "name" => "gallery", "widget" => "list",
        "field" => { "$ref" => "#/field_library/body_markdown" } },
    ])
    out = FL.resolve(frag, LIBRARY)
    nested = out.first["fields"].first["field"]
    assert_equal "body", nested["name"]
    refute nested.key?("$ref")
  end

  def test_real_packaged_library_loads_and_carries_the_date_format_contract
    lib = FL.load_library(REAL_LIBRARY_PATH)
    assert lib.key?("body_markdown"), "field_library.yml must define body_markdown"
    assert lib.key?("published_pair"), "field_library.yml must define published_pair"
    assert lib.key?("date_widget"), "field_library.yml must define date_widget"
    assert lib.key?("image_widget"), "field_library.yml must define image_widget"
    # published_pair is a LIST of 2 fields; date_widget is a single field.
    assert_kind_of Array, lib["published_pair"]
    assert_equal 2, lib["published_pair"].length
    assert_kind_of Hash, lib["date_widget"]
    # The cross-engine date format token must match config.base.yml VERBATIM.
    assert_equal "YYYY-MM-DD HH:mm:ss ZZ", lib["date_widget"]["format"]
    publish_date = lib["published_pair"].find { |f| f["name"] == "publish_date" }
    assert_equal "YYYY-MM-DD HH:mm:ss ZZ", publish_date["format"]
  end
end
