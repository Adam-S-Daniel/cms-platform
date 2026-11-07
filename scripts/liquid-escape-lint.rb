#!/usr/bin/env ruby
# frozen_string_literal: true

# liquid-escape-lint: every Liquid output in an HTML or XML template must be
# encoded for the context it lands in, just before it lands there.
#
# THE RULE (_agent-guidance#467, the owner's standing rule for all code):
# untrusted data is escaped or encoded, with a well-established library or
# built-in, in the manner each output context needs, just before it is placed
# into that context. Rejecting or stripping input is not a substitute. In a
# Jekyll template the built-ins are Liquid's filters, so each `{{ ... }}` must
# END in a filter that encodes for where it prints:
#
#   HTML text or attribute value, XML   escape, escape_once, xml_escape,
#                                       cgi_escape, url_encode, slugify
#   inside <script>                     a number, or JSON as
#                                       `| jsonify | replace: "<", "\u003c"`
#                                       (`jsonify` alone leaves `</script>`
#                                       intact); otherwise a data- attribute
#                                       with `| escape`
#   inside a {% capture %} that builds  jsonify (the capture is then checked
#     JSON (any value ends in jsonify)    where it prints, like any value)
#   inside <style> or <![CDATA[ ]]>     numbers only: drop the CDATA section
#                                       for `| xml_escape`; move style data to
#                                       an HTML attribute
#   anywhere                            numeric and date filters, whose output
#                                       carries no markup (size, plus, date, ...)
#
# `relative_url` / `absolute_url` / `uri_escape` are NOT HTML encoders: they
# leave `&`, `'` and more as they are. Write `{{ x | relative_url | escape }}`.
#
# WHAT PASSES WITHOUT A FILTER, and why:
#   - a literal outside <script>/<style> whose filters take only literals
#     (`{{ '/blog/' | relative_url }}`): only the site's own `baseurl` / `url`
#     config joins it. `{{ '/tags/' | append: slug }}` carries data and is
#     checked like any other output.
#   - `{{ content }}`: Jekyll's rendered page body, markup by design.
#   - a variable `{% capture %}`d in the same template: its body is checked
#     here, so it is markup built from already-encoded parts. A capture that
#     builds JSON is NOT exempt: it is encoded where it prints.
#   - an entry in the repo's `.liquid-escape-allowlist.txt` (below).
#
# HOW IT READS A TEMPLATE. It parses with the `liquid` gem (the AST, never a
# regex over `{{`), walks every Variable node with its filter chain, and
# tracks whether the raw text before it has opened a <script> or <style>
# element. Front matter is blanked, line count kept, so line numbers match.
# Tags Liquid does not know (Jekyll's `include`, `seo`, `highlight`, ...) are
# parsed as inert placeholders: a tag's arguments are not output.
#
# ALLOWLIST. `.liquid-escape-allowlist.txt` at the repo root, one entry per
# line: `<path> | <the output's markup, as the finding prints it> | <reason>`.
# The markup may contain ` | ` (its filters); the reason may not.
# The reason is required: an entry is a decision that this output is markup on
# purpose (an editor's Markdown through `markdownify`, say), and the reason is
# its record. Blank lines and lines starting with `#` are ignored. An entry
# that matches nothing is reported, so the file cannot silently go stale.
#
# Usage:
#   liquid-escape-lint.rb --staged          staged .html/.xml files (pre-commit)
#   liquid-escape-lint.rb --all [<dir>]     every tracked template under <dir>
#   liquid-escape-lint.rb <file>...         just these files
#
# Exit 0 clean, 1 on any finding, 2 on usage or parse error. With --staged and
# no `liquid` gem loadable it prints a notice and exits 0: CI is the gate
# (site-verify.yml runs --all), the hook is the early warning. Bypass the hook
# for one commit (emergency only): SKIP_LIQUID_ESCAPE_LINT=1 git commit ...
#
# Platform-authoritative: cms-platform's dev-hooks-sync.yml overwrites this
# file in every consumer. Change it in cms-platform.

require "shellwords"
begin
  require "liquid"
rescue LoadError
  if ARGV.first == "--staged"
    puts "liquid-escape-lint: the liquid gem is not installed here, skipping (CI runs it)"
    exit 0
  end
  warn "liquid-escape-lint: needs the liquid gem (gem install liquid, or bundle exec)"
  exit 2
end

module LiquidEscapeLint
  HTML_ENCODERS = %w[escape escape_once xml_escape cgi_escape url_encode slugify].freeze
  # Filters whose output is a number or a formatted date: no markup can survive.
  INERT = %w[
    size plus minus times divided_by modulo round ceil floor abs at_least at_most
    number_of_words date date_to_xmlschema date_to_rfc822 date_to_string
    date_to_long_string
  ].freeze
  NUMERIC = (INERT - %w[date date_to_xmlschema date_to_rfc822 date_to_string date_to_long_string]).freeze
  ALLOWLIST = ".liquid-escape-allowlist.txt"
  SKIP_DIRS = %r{(\A|/)(_site|vendor|node_modules|\.git|\.cms-platform|\.bundle)/}.freeze

  Finding = Struct.new(:path, :line, :markup, :message)

  # An inert stand-in for a tag Liquid does not know. It keeps the parse going
  # and renders nothing; its arguments are never output, so there is nothing
  # in them to check.
  class InertTag < Liquid::Tag; end

  # Jekyll's `highlight` encloses literal code until `endhighlight`.
  # It takes a language argument, which Liquid's own `raw` refuses.
  class InertRaw < Liquid::Raw
    protected

    def ensure_valid_markup(_tag_name, _markup, _parse_context); end
  end

  def self.install_inert_tags
    registry = Liquid::Template.tags
    Liquid::Template.register_tag("highlight", InertRaw) unless registry["highlight"]
    registry.singleton_class.send(:define_method, :[]) do |name|
      found = super(name)
      next found if found
      next nil if name.to_s.start_with?("end")

      InertTag
    end
  end

  # Blank a leading YAML front matter block, keeping its newlines.
  def self.strip_front_matter(src)
    m = src.match(/\A---[ \t]*\r?\n.*?^---[ \t]*\r?\n/m)
    return src unless m

    m[0].gsub(/[^\n]/, "") + src[m[0].length..]
  end

  class Checker
    attr_reader :findings

    def initialize(path, src)
      @path = path
      @src = src
      @findings = []
      @captured = []
      @json_captures = []
      @raw_before = +""
    end

    def run
      template = Liquid::Template.parse(LiquidEscapeLint.strip_front_matter(@src), line_numbers: true)
      collect_captures(template.root)
      walk(template.root)
      self
    end

    private

    def children(node)
      list = node.respond_to?(:nodelist) ? node.nodelist : nil
      return [] unless list

      list.flat_map { |c| c.is_a?(Liquid::BlockBody) ? c.nodelist : [c] }
    end

    def collect_captures(node)
      children(node).each do |c|
        if c.is_a?(Liquid::Capture)
          name = c.instance_variable_get(:@to)
          @captured << name
          @json_captures << name if variables(c).any? { |v| v.filters.last&.first == "jsonify" }
        end
        collect_captures(c) unless c.is_a?(String) || c.is_a?(Liquid::Variable)
      end
    end

    def variables(node)
      children(node).flat_map do |c|
        next [] if c.is_a?(String) || c.is_a?(Liquid::Comment) || c.is_a?(Liquid::Raw)
        next [c] if c.is_a?(Liquid::Variable)

        variables(c)
      end
    end

    def walk(node, capture: nil)
      children(node).each do |c|
        case c
        when String
          @raw_before << c
        when Liquid::Variable
          check(c, capture)
        when Liquid::Comment, Liquid::Raw
          next
        when Liquid::Capture
          walk(c, capture: c.instance_variable_get(:@to))
        else
          walk(c, capture: capture)
        end
      end
    end

    # The element whose content the next output lands in, from the raw text
    # seen so far: a lexical scan for the last opening/closing script or style
    # tag, which is all the context the rule distinguishes.
    def context
      cdata_open = @raw_before.rindex("<![CDATA[")
      return :cdata if cdata_open && !@raw_before.index("]]>", cdata_open)

      last = nil
      @raw_before.scan(%r{<(/?)(script|style)\b[^>]*>?}i) do
        last = Regexp.last_match
      end
      return :html if last.nil? || last[1] == "/"
      # `<script src="{{ x }}"`: still inside the opening tag, so an attribute.
      return :html unless last[0].end_with?(">")

      last[2].downcase.to_sym
    end

    def check(var, capture)
      filters = var.filters.map(&:first)
      final = filters.last
      name = var.name
      markup = var.raw.to_s.strip
      line = var.line_number

      ctx = context
      return if literal?(name) && filters.empty?
      return if literal?(name) && ctx == :html && literal_args?(var)
      return if filters.empty? && lookup_name(name) == "content"
      json_capture = @json_captures.include?(lookup_name(name))
      return if filters.empty? && @captured.include?(lookup_name(name)) && !json_capture

      ok, need =
        if capture && @json_captures.include?(capture)
          [final == "jsonify" || NUMERIC.include?(final),
           "end in `| jsonify` (it builds the JSON captured as `#{capture}`)"]
        else
          case ctx
          when :script
            [NUMERIC.include?(final) || script_safe_json?(var, json_capture),
             "be a number, or JSON ending in `| jsonify | replace: \"<\", \"\\u003c\"` (it is inside " \
             "<script>, and `jsonify` alone leaves `</script>` intact); or put the value in a data- " \
             "attribute with `| escape` and read it from `document.currentScript.dataset`"]
          when :cdata
            [NUMERIC.include?(final),
             "not print inside <![CDATA[ ]]> (no filter encodes `]]>` there); drop the CDATA " \
             "section and end the output in `| xml_escape`"]
          when :style
            [NUMERIC.include?(final),
             "be a number (it is inside <style>); move the value to an HTML attribute with `| escape`"]
          else
            [HTML_ENCODERS.include?(final) || INERT.include?(final),
             "end in an HTML encoder such as `| escape`#{final ? " (`#{final}` does not HTML-encode)" : ''}"]
          end
        end
      return if ok

      @findings << Finding.new(@path, line, markup, "must #{need}")
    end

    # JSON made safe for a script body: `jsonify` (or a capture whose values
    # all end in `jsonify`), then `<` replaced by the JSON escape `\u003c`, so
    # no `</script` or `<!--` can form. Liquid string literals keep the
    # backslash, so the JSON parser reads `\u003c` back as `<`.
    def script_safe_json?(var, json_capture)
      last_name, last_args = var.filters.last
      return false unless last_name == "replace" && last_args == ["<", "\\u003c"]

      json_capture || var.filters[0..-2].any? { |f| f.first == "jsonify" }
    end

    def literal?(name)
      !(name.is_a?(Liquid::VariableLookup) || name.is_a?(Liquid::RangeLookup))
    end

    # True when no filter argument reads a variable: `'/tags/' | append: slug`
    # carries data even though it starts from a literal.
    def literal_args?(var)
      var.filters.all? do |_name, args, kwargs|
        (Array(args) + Array(kwargs&.values)).all? { |a| literal?(a) }
      end
    end

    def lookup_name(name)
      return nil unless name.is_a?(Liquid::VariableLookup)
      return nil unless name.lookups.empty?

      name.name
    end
  end

  def self.load_allowlist(root)
    file = File.join(root, ALLOWLIST)
    return [] unless File.file?(file)

    File.readlines(file, chomp: true).each_with_index.filter_map do |line, i|
      next if line.strip.empty? || line.lstrip.start_with?("#")

      # The markup itself may hold ` | ` (a filter chain), so the path is the
      # first field, the reason the last, and the markup all between.
      parts = line.split(" | ").map(&:strip)
      path = parts.first
      reason = parts.size >= 3 ? parts.last : nil
      markup = parts.size >= 3 ? parts[1..-2].join(" | ") : nil
      if path.to_s.empty? || markup.to_s.empty? || reason.to_s.empty?
        warn "liquid-escape-lint: #{ALLOWLIST}:#{i + 1}: needs `<path> | <markup> | <reason>`"
        exit 2
      end
      { path: path, markup: markup, line: i + 1, used: false }
    end
  end

  def self.template?(path)
    path.end_with?(".html", ".xml") && !SKIP_DIRS.match?(path)
  end

  def self.lint(files, root)
    allow = load_allowlist(root)
    findings = []
    files.each do |rel|
      src = File.read(File.join(root, rel), encoding: "UTF-8")
      next unless src.include?("{{") || src.include?("{%")

      begin
        Checker.new(rel, src).run.findings.each do |f|
          entry = allow.find { |a| a[:path] == f.path && a[:markup] == f.markup }
          if entry
            entry[:used] = true
          else
            findings << f
          end
        end
      rescue Liquid::Error => e
        warn "liquid-escape-lint: #{rel}: could not parse: #{e.message}"
        exit 2
      end
    end
    [findings, allow]
  end

  def self.main(argv)
    if ENV["SKIP_LIQUID_ESCAPE_LINT"] == "1"
      puts "liquid-escape-lint: skipped (SKIP_LIQUID_ESCAPE_LINT=1)"
      return 0
    end
    mode = argv.first
    root = Dir.pwd
    files =
      case mode
      when "--staged"
        root = `git rev-parse --show-toplevel`.strip
        `git -C #{root.shellescape} diff --cached --name-only --diff-filter=ACM -z`.force_encoding("UTF-8").split("\0")
      when "--all"
        root = File.expand_path(argv[1] || ".")
        `git -C #{root.shellescape} ls-files -z`.force_encoding("UTF-8").split("\0")
      when nil, "-h", "--help"
        warn "usage: liquid-escape-lint.rb --staged | --all [<dir>] | <file>..."
        return 2
      else
        argv
      end
    files = files.select { |f| template?(f) && File.file?(File.join(root, f)) }
    findings, allow = lint(files, root)
    findings.each do |f|
      puts "#{f.path}:#{f.line}: `{{ #{f.markup} }}` #{f.message}"
    end
    stale = mode == "--all" ? allow.reject { |a| a[:used] } : []
    stale.each do |a|
      puts "#{ALLOWLIST}:#{a[:line]}: matches no output (#{a[:path]} | #{a[:markup]}); remove it"
    end
    if findings.any?
      puts ""
      puts "liquid-escape-lint: #{findings.size} Liquid output(s) are not encoded for where they print."
      puts "Untrusted data is encoded with a built-in filter for its context, just before it is placed"
      puts "there (_agent-guidance#467). Add the filter; if an output is markup on purpose, add a"
      puts "`<path> | <markup> | <reason>` line to #{ALLOWLIST}."
    end
    findings.any? || stale.any? ? 1 : 0
  end
end

if $PROGRAM_NAME == __FILE__
  LiquidEscapeLint.install_inert_tags
  exit LiquidEscapeLint.main(ARGV)
end
