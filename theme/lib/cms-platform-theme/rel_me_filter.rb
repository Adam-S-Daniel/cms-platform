# frozen_string_literal: true

#
# Liquid filter `rel_me_urls` — the site's cross-post profile URLs, validated,
# for `<link rel="me">` in <head> (_includes/rel-me.html).
#
# A site lists the profiles it cross-posts to in _config.yml:
#
#   cross_post:
#     profiles:
#       mastodon: https://hachyderm.io/@someone
#       linkedin: https://www.linkedin.com/in/someone
#       substack: https://someone.substack.com
#
# rel="me" is how Mastodon (and IndieWeb tools) verify that the site and the
# profile belong to the same person: Mastodon shows the site as verified once
# the profile lists the site URL and the site links back with rel="me".
#
# Returns the URLs ordered by target name. Blank values are skipped (a target
# left unset); anything that is not an absolute https URL raises, failing the
# build instead of shipping a broken or unsafe link.

require 'uri'

module Jekyll
  module RelMeFilter
    def rel_me_urls(profiles)
      return [] if profiles.nil?
      raise ArgumentError, "cross_post.profiles must be a map of target => profile URL" unless profiles.is_a?(Hash)

      profiles.keys.map(&:to_s).sort.filter_map do |target|
        value = profiles[target]
        next if value.nil? || (value.is_a?(String) && value.strip.empty?)

        url = value.is_a?(String) ? value.strip : nil
        uri = begin
          url && URI.parse(url)
        rescue URI::InvalidURIError
          nil
        end
        unless uri.is_a?(URI::HTTPS) && !uri.host.to_s.empty?
          raise ArgumentError, "cross_post.profiles.#{target} must be an absolute https:// URL, got #{value.inspect}"
        end

        url
      end
    end
  end
end

Liquid::Template.register_filter(Jekyll::RelMeFilter)
