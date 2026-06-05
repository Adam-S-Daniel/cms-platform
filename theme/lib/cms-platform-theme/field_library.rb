# frozen_string_literal: true
# Platform field_library $ref resolver — the SINGLE source of truth shared by
# BOTH Decap render paths so they stay byte-in-lockstep (parity-locked by
# e2e/decap-config-render-parity.test.js):
#   - scripts/render-decap-config.rb                    (deploy-time CLI)
#   - theme/lib/cms-platform-theme/decap_config_hook.rb (gem-time Jekyll hook)
#
# A site's SITE-OWNED seam admin/collections.site.yml may reuse platform field
# defs by writing `$ref: "#/field_library/<name>"` where a field (or fields)
# would go, instead of re-authoring the YAML. This module expands every such
# `$ref` into a DEEP COPY of the referenced def from theme/admin/field_library.yml
# BEFORE the fragment is dumped to YAML text and spliced at the
# `# __SITE_COLLECTIONS__` marker in config.base.yml. Decap NEVER sees a `$ref`.
#
# A ref resolves to EITHER a single field (a Hash → spliced as one list item)
# OR a list of fields (an Array, e.g. published_pair → 2 fields → spliced in
# place). `$ref`s are OPTIONAL and fully backward-compatible: a fragment with
# no `$ref` is returned structurally unchanged.
require "yaml"

module CmsPlatformTheme
  module FieldLibrary
    REF_KEY = "$ref"
    REF_PREFIX = "#/field_library/"

    module_function

    # Load the platform field_library defs (the `field_library:` mapping) from
    # a field_library.yml path. Returns the inner Hash<String, def>.
    def load_library(path)
      doc = YAML.load_file(path) || {}
      doc["field_library"] || {}
    end

    # Resolve every `$ref: "#/field_library/<name>"` in a parsed
    # collections.site.yml fragment (a list of collection objects, or any
    # nested structure). Returns a NEW structure with refs expanded; the input
    # is not mutated. `library` is the Hash returned by load_library.
    #
    # Resolution rules:
    #   - Inside any `fields:` (or singular `field:`) SEQUENCE, a list item that
    #     is exactly a `$ref` mapping is replaced: a single-field def (Hash)
    #     becomes one item; a multi-field def (Array) is spliced in place.
    #   - A `$ref` mapping used as a singular `field:` VALUE resolves to a single
    #     field (a multi-field def there is an error — `field:` takes one field).
    #   - Resolved defs are DEEP-COPIED so two refs to the same name never share
    #     mutable state.
    #   - An unresolvable `$ref` (unknown name / malformed pointer) raises.
    def resolve(node, library)
      case node
      when Array
        node.map { |el| resolve(el, library) }
      when Hash
        out = {}
        node.each do |k, v|
          if (k == "fields" || k == "field") && v.is_a?(Array)
            # A sequence of fields: expand list items, splicing multi-field refs.
            out[k] = expand_field_list(v, library)
          elsif k == "field" && ref_node?(v)
            # Singular `field:` whose value is a $ref → exactly one field.
            resolved = resolve_ref(v, library)
            raise unresolved(v[REF_KEY], "a singular `field:` requires a single field, but it resolves to a LIST") if resolved.is_a?(Array)
            out[k] = resolved
          else
            out[k] = resolve(v, library)
          end
        end
        out
      else
        node
      end
    end

    # Expand a `fields:` list: each element that is a bare `$ref` mapping is
    # replaced by its resolved def (single → one item, list → spliced); every
    # other element is recursed into (so nested fields/refs also resolve).
    def expand_field_list(list, library)
      result = []
      list.each do |el|
        if ref_node?(el)
          resolved = resolve_ref(el, library)
          if resolved.is_a?(Array)
            result.concat(resolved)
          else
            result << resolved
          end
        else
          result << resolve(el, library)
        end
      end
      result
    end

    # True iff `node` is a mapping consisting solely of a `$ref` pointer.
    def ref_node?(node)
      node.is_a?(Hash) && node.key?(REF_KEY) && node.keys.size == 1
    end

    # Resolve a single `$ref` mapping to a DEEP COPY of the referenced def.
    # Raises on a malformed pointer or an unknown field_library name.
    def resolve_ref(ref, library)
      pointer = ref[REF_KEY]
      unless pointer.is_a?(String) && pointer.start_with?(REF_PREFIX)
        raise unresolved(pointer, "only \"#{REF_PREFIX}<name>\" pointers are supported")
      end
      name = pointer[REF_PREFIX.length..]
      unless library.key?(name)
        raise unresolved(pointer, "no such field_library entry (known: #{library.keys.sort.join(', ')})")
      end
      deep_copy(library[name])
    end

    # A clean ArgumentError with a clear, render-aborting message.
    def unresolved(pointer, why)
      ArgumentError.new("field_library: unresolved $ref #{pointer.inspect} — #{why}")
    end

    # Deep copy via Marshal so resolved defs never share mutable state across
    # two refs to the same name (the def YAML holds only plain Hash/Array/scalars).
    def deep_copy(obj)
      Marshal.load(Marshal.dump(obj))
    end

    # Produce the TEXT to splice at the `# __SITE_COLLECTIONS__` marker for a
    # given raw seam (admin/collections.site.yml) text. This is the ONE place
    # both render paths call, so they stay byte-in-lockstep.
    #
    # BACKWARD-COMPAT GUARANTEE: if the seam contains no `$ref`, the raw text is
    # returned UNCHANGED — byte-identical to the legacy text-splice. So every
    # existing inline-only consumer (adamdaniel's notes, jodidaniel's
    # collections) renders exactly as before; only a seam that opts into a
    # `$ref` is parsed/re-emitted.
    #
    #   raw          : the seam file's text ("" when the site has no seam)
    #   library_path : path to the platform field_library.yml (resolved next to
    #                  config.base.yml). Loaded lazily — only when a $ref exists.
    def expand_seam_text(raw, library_path)
      return raw unless raw.include?(REF_KEY)
      fragment = YAML.load(raw)
      return raw if fragment.nil?
      library = load_library(library_path)
      resolved = resolve(fragment, library)
      reindent_collections_yaml(resolved)
    end

    # Dump a resolved collections fragment (a sequence of collection mappings)
    # back to the 2-space-indented list text the marker sits at. YAML.dump emits
    # sequence items at column 0 (`- name:`); the marker lives at 2-space indent
    # inside `collections:`, so every line is shifted right by 2 spaces. A blank
    # line stays blank (no trailing whitespace). The leading `---\n` document
    # marker is stripped.
    def reindent_collections_yaml(fragment)
      body = YAML.dump(fragment).sub(/\A---\n/, "")
      body.each_line.map { |line| line.strip.empty? ? line : "  #{line}" }.join
    end
  end
end
