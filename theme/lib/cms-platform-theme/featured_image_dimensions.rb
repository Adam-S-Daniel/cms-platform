# frozen_string_literal: true

# Give the post hero <img> its width and height, so the browser reserves its
# box before the image loads and the page does not shift (#688).
#
# For every page and document with a `featured_image:`, this leaves
# `featured_image_width` / `featured_image_height` either both set to positive
# integers or both unset, so _layouts/post.html can emit the attributes only
# when they are known:
#   1. both set in front matter as positive integers -> kept (they win), else
#   2. read from the image file's header at build time, else
#   3. both removed (the layout then omits width/height entirely).
#
# The file is looked up under the site source, then the theme gem's root (as
# cachebust_filter.rb does). A site-relative path ("/assets/x.png" or
# "assets/x.png") and an absolute URL on the site's own `url` resolve; any other
# URL (a CDN, another host), a path escaping those roots, a missing file and an
# unknown format give no dimensions. PNG, GIF, JPEG and WebP headers are parsed
# with the standard library only; a JPEG's EXIF orientation is honored, since a
# browser displays a rotated photo with its sides swapped.
#
# Tests: spec/featured_image_dimensions_test.rb

module Jekyll
  module FeaturedImageDimensions
    KEYS = %w[featured_image_width featured_image_height].freeze
    # Start-of-frame markers carrying the frame size: C0-CF except DHT (C4),
    # JPG (C8) and DAC (CC).
    JPEG_SOF = ((0xC0..0xCF).to_a - [0xC4, 0xC8, 0xCC]).freeze
    # Markers with no length field.
    JPEG_STANDALONE = ([0x01, 0xD8] + (0xD0..0xD7).to_a).freeze

    module_function

    def apply(item, site)
      src = item.data['featured_image']
      return unless src.is_a?(String) && !src.strip.empty?

      size = front_matter_size(item.data) || file_size(site, src.strip)
      if size
        KEYS.zip(size).each { |key, value| item.data[key] = value }
      else
        KEYS.each { |key| item.data.delete(key) }
      end
    end

    def front_matter_size(data)
      size = KEYS.map { |key| positive_integer(data[key]) }
      size.all? ? size : nil
    end

    def positive_integer(value)
      number = value.is_a?(Integer) ? value : (value.to_s.strip.match?(/\A\d+\z/) ? value.to_s.to_i : nil)
      number&.positive? ? number : nil
    end

    def file_size(site, src)
      path = local_path(site, src)
      path ? dimensions(path) : nil
    end

    # The file a featured_image value names, or nil when it is not local.
    def local_path(site, src)
      relative = src.sub(/[?#].*\z/m, '')
      if relative.start_with?('//') || relative.match?(/\A[a-z][a-z0-9+.-]*:/i)
        own = site.config['url'].to_s.chomp('/')
        return nil if own.empty? || !relative.start_with?("#{own}/")

        relative = relative.delete_prefix(own)
        baseurl = site.config['baseurl'].to_s.chomp('/')
        relative = relative.delete_prefix(baseurl) if !baseurl.empty? && relative.start_with?("#{baseurl}/")
      end
      relative = relative.sub(%r{\A/+}, '')
      return nil if relative.empty?

      roots(site).each do |root|
        candidate = File.expand_path(relative, root)
        return candidate if candidate.start_with?("#{root}/") && File.file?(candidate)
      end
      nil
    end

    def roots(site)
      theme = site.respond_to?(:theme) ? site.theme : nil
      theme_root = theme.respond_to?(:root) ? theme.root : nil
      [site.source, theme_root].compact.map { |root| File.expand_path(root) }
    end

    # [width, height] from the file's header, or nil for an unknown format or a
    # truncated or unreadable file.
    def dimensions(path)
      File.open(path, 'rb') do |file|
        head = file.read(30).to_s
        size =
          if head.start_with?("\x89PNG\r\n\x1A\n".b) && head.byteslice(12, 4) == 'IHDR'
            head.unpack('@16NN')
          elsif head.start_with?('GIF87a', 'GIF89a')
            head.unpack('@6vv')
          elsif head.start_with?('RIFF') && head.byteslice(8, 4) == 'WEBP'
            webp(head)
          elsif head.start_with?("\xFF\xD8".b)
            file.seek(2)
            jpeg(file)
          end
        size if size&.all? { |value| value.is_a?(Integer) && value.positive? }
      end
    rescue SystemCallError, IOError, ArgumentError, TypeError
      nil
    end

    def webp(head)
      chunk = head.byteslice(12, 4)
      # Bytes each header needs: VP8L's size field ends at 25, the others' at 30.
      return nil if head.bytesize < (chunk == 'VP8L' ? 25 : 30)

      case chunk
      when 'VP8 '
        return nil unless head.byteslice(23, 3) == "\x9D\x01\x2A".b

        head.unpack('@26vv').map { |value| value & 0x3FFF }
      when 'VP8L'
        return nil unless head.getbyte(20) == 0x2F

        bits = head.unpack1('@21V')
        [(bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1]
      when 'VP8X'
        bytes = head.unpack('@24C6')
        [bytes[0] | (bytes[1] << 8) | (bytes[2] << 16), bytes[3] | (bytes[4] << 8) | (bytes[5] << 16)].map { |value| value + 1 }
      end
    end

    # Walks the marker segments up to the first start-of-frame.
    def jpeg(file)
      orientation = nil
      loop do
        byte = file.readbyte
        next unless byte == 0xFF

        marker = file.readbyte
        marker = file.readbyte while marker == 0xFF
        next if JPEG_STANDALONE.include?(marker)
        return nil if marker == 0xD9 || marker == 0xDA

        length = file.read(2).unpack1('n')
        return nil if length < 2

        segment = file.read(length - 2).to_s
        return nil if segment.bytesize < length - 2

        if JPEG_SOF.include?(marker)
          height, width = segment.unpack('@1nn')
          return orientation.to_i.between?(5, 8) ? [height, width] : [width, height]
        end
        orientation ||= exif_orientation(segment) if marker == 0xE1
      end
    rescue EOFError
      nil
    end

    # The EXIF orientation tag (0x0112) from an APP1 segment, or nil.
    def exif_orientation(segment)
      return nil unless segment.start_with?("Exif\0\0".b)

      tiff = segment.byteslice(6..)
      short, long = { 'II' => %w[v V], 'MM' => %w[n N] }[tiff.byteslice(0, 2)]
      return nil unless short && tiff.bytesize >= 8

      ifd = tiff.byteslice(4, 4).unpack1(long)
      count = tiff.byteslice(ifd, 2)&.unpack1(short)
      return nil unless count

      count.times do |index|
        entry = tiff.byteslice(ifd + 2 + (index * 12), 12)
        return nil unless entry && entry.bytesize == 12
        return entry.byteslice(8, 2).unpack1(short) if entry.byteslice(0, 2).unpack1(short) == 0x0112
      end
      nil
    end
  end
end

if defined?(Jekyll::Hooks)
  # :post_read fires once per site after front matter is parsed and before
  # rendering, so the layout sees the normalized keys.
  Jekyll::Hooks.register :site, :post_read do |site|
    (site.pages + site.documents).each { |item| Jekyll::FeaturedImageDimensions.apply(item, site) }
  end
end
