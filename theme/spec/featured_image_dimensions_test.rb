# frozen_string_literal: true

# Real Jekyll build of the real _layouts/post.html with the theme's
# featured_image_dimensions hook (#688). The post hero <img> had no width or
# height, so the page shifted as it loaded. It must carry both when they are
# known (front matter, else the image file) and neither, never an empty
# attribute, when they are not. It decodes async and is never lazy-loaded.
# Run with: ruby theme/spec/featured_image_dimensions_test.rb
# Needs jekyll 4.4.1 and jekyll-seo-tag 2.9.0 (the ruby-theme-specs lane installs both).

require 'minitest/autorun'
require 'fileutils'
require 'tmpdir'
require 'zlib'
require 'rexml/document'
require 'jekyll'
require 'jekyll-seo-tag'
require_relative '../lib/cms-platform-theme/featured_image_dimensions'
require_relative '../lib/cms-platform-theme/seo_image'
require_relative '../lib/cms-platform-theme/cachebust_filter'
require_relative '../lib/cms-platform-theme/rel_me_filter'

module ImageBytes
  module_function

  def png(width, height)
    ihdr = [width, height, 8, 2, 0, 0, 0].pack('NNCCCCC')
    "\x89PNG\r\n\x1A\n".b + [13].pack('N') + 'IHDR'.b + ihdr + [Zlib.crc32("IHDR#{ihdr}")].pack('N')
  end

  def gif(width, height)
    'GIF89a'.b + [width, height].pack('vv') + "\x00\x00\x00".b
  end

  # SOI, an optional APP1 Exif segment carrying `orientation`, a DQT segment
  # to skip, then SOF0.
  def jpeg(width, height, orientation: nil)
    bytes = "\xFF\xD8".b
    if orientation
      tiff = 'MM'.b + [42, 8].pack('nN') + [1].pack('n') + [0x0112, 3, 1, orientation, 0].pack('nnNnn') + [0].pack('N')
      app1 = "Exif\0\0".b + tiff
      bytes += "\xFF\xE1".b + [app1.bytesize + 2].pack('n') + app1
    end
    bytes += "\xFF\xDB".b + [67].pack('n') + ("\x00".b * 65)
    bytes + "\xFF\xC0".b + [17, 8, height, width, 3].pack('nCnnC') + ("\x01\x11\x00".b * 3) + "\xFF\xD9".b
  end

  def webp(chunk, payload)
    body = 'WEBP'.b + chunk.b + [payload.bytesize].pack('V') + payload
    'RIFF'.b + [body.bytesize].pack('V') + body
  end

  def webp_vp8(width, height)
    webp('VP8 ', "\x00\x00\x00\x9D\x01\x2A".b + [width, height].pack('vv') + ("\x00".b * 4))
  end

  def webp_vp8l(width, height)
    webp('VP8L', "\x2F".b + [(width - 1) | ((height - 1) << 14)].pack('V') + ("\x00".b * 4))
  end

  def webp_vp8x(width, height)
    w = width - 1
    h = height - 1
    webp('VP8X', "\x00\x00\x00\x00".b + [w & 0xFF, (w >> 8) & 0xFF, w >> 16, h & 0xFF, (h >> 8) & 0xFF, h >> 16].pack('C6'))
  end
end

class FeaturedImageDimensionsTest < Minitest::Test
  ROOT = File.expand_path('../..', __dir__)
  UPLOADS = 'assets/images/uploads'

  FILES = {
    'hero.png' => ImageBytes.png(2300, 1128),
    'hero.webp' => ImageBytes.webp_vp8x(1460, 716),
    'not-an-image.png' => "just text, not a PNG\n",
  }.freeze

  POSTS = {
    'from-file' => "featured_image: /#{UPLOADS}/hero.png\n",
    'from-webp' => "featured_image: /#{UPLOADS}/hero.webp\n",
    'relative-path' => "featured_image: #{UPLOADS}/hero.png\n",
    'own-absolute-url' => "featured_image: https://example.com/#{UPLOADS}/hero.png?v=1\n",
    'front-matter-wins' => "featured_image: /#{UPLOADS}/hero.png\nfeatured_image_width: 800\nfeatured_image_height: 600\n",
    'front-matter-only' => "featured_image: /#{UPLOADS}/missing.png\nfeatured_image_width: \"640\"\nfeatured_image_height: \"480\"\n",
    'partial-front-matter' => "featured_image: /#{UPLOADS}/missing.png\nfeatured_image_width: 640\n",
    'invalid-front-matter' => "featured_image: /#{UPLOADS}/missing.png\nfeatured_image_width: wide\nfeatured_image_height: 0\n",
    'missing-file' => "featured_image: /#{UPLOADS}/missing.png\n",
    'remote-url' => "featured_image: https://cdn.example.net/#{UPLOADS}/hero.png\n",
    'protocol-relative' => "featured_image: //cdn.example.net/#{UPLOADS}/hero.png\n",
    'unknown-format' => "featured_image: /#{UPLOADS}/not-an-image.png\n",
    'escapes-source' => "featured_image: /../outside.png\n",
    'without-image' => "title: Without image\n",
  }.freeze

  def setup
    @tmpdir = Dir.mktmpdir('featured-image-dimensions-')
  end

  def teardown
    FileUtils.remove_entry(@tmpdir) if @tmpdir
  end

  def build
    source = File.join(@tmpdir, 'source')
    @destination = File.join(@tmpdir, 'output')
    FileUtils.mkdir_p(File.join(source, '_posts'))
    FileUtils.mkdir_p(File.join(source, '_layouts'))
    FileUtils.mkdir_p(File.join(source, UPLOADS))
    %w[default.html post.html].each do |layout|
      FileUtils.cp(File.join(ROOT, 'theme', '_layouts', layout), File.join(source, '_layouts', layout))
    end
    %w[feed-link.html favicon.html rel-me.html header.html footer.html share-row.html tag-pills.html analytics/cloudwatch-rum.html].each do |include|
      destination = File.join(source, '_includes', include)
      FileUtils.mkdir_p(File.dirname(destination))
      FileUtils.cp(File.join(ROOT, 'theme', '_includes', include), destination)
    end
    FILES.each { |name, bytes| File.binwrite(File.join(source, UPLOADS, name), bytes) }
    # A real image just outside the source, to prove a path cannot reach it.
    File.binwrite(File.join(@tmpdir, 'outside.png'), ImageBytes.png(10, 10))
    POSTS.each do |slug, front_matter|
      File.write(File.join(source, '_posts', "2024-01-01-#{slug}.md"),
                 "---\nlayout: post\ntitle: #{slug}\n#{front_matter}---\nBody for #{slug}.\n")
    end

    Jekyll::Site.new(Jekyll.configuration({
      'source' => source,
      'destination' => @destination,
      'url' => 'https://example.com',
      'title' => 'Example',
      'permalink' => '/blog/:slug/',
      'timezone' => 'UTC',
      'quiet' => true,
      'plugins' => [],
    })).process
  end

  # Attributes of every <img class="featured-image"> in a built page. Each
  # <img ...> tag is parsed as an XML element, so an empty width="" reads as
  # an empty string, distinct from an absent attribute (nil).
  def heroes(slug)
    html = File.read(File.join(@destination, 'blog', slug, 'index.html'))
    html.scan(/<!--.*?-->|<(?:"[^"]*"|'[^']*'|[^'">])*>/m).filter_map do |token|
      next unless token.match?(/\A<img\b/i)

      element = REXML::Document.new(token.sub(%r{/?>\z}, '/>')).root
      attributes = element.attributes.each_attribute.to_h { |attribute| [attribute.name, attribute.value] }
      attributes if attributes['class'].to_s.split.include?('featured-image')
    end
  end

  def hero(slug)
    found = heroes(slug)
    assert_equal 1, found.size, "#{slug} must render exactly one hero"
    found.first
  end

  def assert_size(slug, width, height)
    attributes = hero(slug)
    assert_equal [width.to_s, height.to_s], attributes.values_at('width', 'height'), slug
  end

  def assert_no_size(slug)
    attributes = hero(slug)
    refute attributes.key?('width'), "#{slug} must not emit width (got #{attributes['width'].inspect})"
    refute attributes.key?('height'), "#{slug} must not emit height (got #{attributes['height'].inspect})"
  end

  def test_dimensions_come_from_the_image_file
    build
    assert_size('from-file', 2300, 1128)
    assert_size('from-webp', 1460, 716)
    assert_size('relative-path', 2300, 1128)
    assert_size('own-absolute-url', 2300, 1128)
  end

  def test_front_matter_overrides_the_file
    build
    assert_size('front-matter-wins', 800, 600)
    assert_size('front-matter-only', 640, 480)
  end

  def test_unknown_dimensions_are_omitted_cleanly
    build
    %w[partial-front-matter invalid-front-matter missing-file remote-url protocol-relative
       unknown-format escapes-source].each { |slug| assert_no_size(slug) }
  end

  def test_the_hero_decodes_async_and_stays_eager
    build
    POSTS.each_key do |slug|
      next if slug == 'without-image'

      attributes = hero(slug)
      assert_equal 'async', attributes['decoding'], slug
      refute attributes.key?('loading'), "#{slug}: the above-the-fold hero must not be lazy-loaded"
      assert_equal '', attributes['alt'], slug
    end
    assert_empty heroes('without-image')
  end

  def write(name, bytes)
    path = File.join(@tmpdir, name)
    File.binwrite(path, bytes)
    path
  end

  def test_header_parsing_per_format
    dims = Jekyll::FeaturedImageDimensions
    assert_equal [2300, 1128], dims.dimensions(write('a.png', ImageBytes.png(2300, 1128)))
    assert_equal [320, 200], dims.dimensions(write('a.gif', ImageBytes.gif(320, 200)))
    assert_equal [1600, 900], dims.dimensions(write('a.jpg', ImageBytes.jpeg(1600, 900)))
    assert_equal [1600, 900], dims.dimensions(write('b.jpg', ImageBytes.jpeg(1600, 900, orientation: 1)))
    # Orientations 5-8 rotate by 90 degrees, so the displayed sides swap.
    assert_equal [900, 1600], dims.dimensions(write('c.jpg', ImageBytes.jpeg(1600, 900, orientation: 6)))
    assert_equal [1460, 716], dims.dimensions(write('a.webp', ImageBytes.webp_vp8(1460, 716)))
    assert_equal [1460, 716], dims.dimensions(write('b.webp', ImageBytes.webp_vp8l(1460, 716)))
    assert_equal [1460, 716], dims.dimensions(write('c.webp', ImageBytes.webp_vp8x(1460, 716)))
  end

  def test_header_parsing_rejects_unknown_truncated_and_missing_files
    dims = Jekyll::FeaturedImageDimensions
    assert_nil dims.dimensions(write('text.png', "not an image\n"))
    assert_nil dims.dimensions(write('empty.png', ''))
    assert_nil dims.dimensions(write('short.png', ImageBytes.png(10, 10).byteslice(0, 20)))
    assert_nil dims.dimensions(write('short.jpg', ImageBytes.jpeg(10, 10).byteslice(0, 30)))
    assert_nil dims.dimensions(write('short.webp', ImageBytes.webp_vp8x(10, 10).byteslice(0, 27)))
    assert_nil dims.dimensions(File.join(@tmpdir, 'does-not-exist.png'))
  end
end
