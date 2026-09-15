cask "zennotes" do
  arch arm: "arm64", intel: "x64"

  version "2.50.3"
  sha256 arm:   "696b48ca816b7712bb84a5c7af9aec750fdc92b7c16f6050c4ff5d115a8c835c",
         intel: "0ce95a454eca1cf6e8274e51088cfb18e1a376cff9ea6b4448bde5752deb8b76"

  url "https://github.com/ZenNotes/zennotes/releases/download/v#{version}/ZenNotes-#{version}-mac-#{arch}.dmg"
  name "ZenNotes"
  desc "Keyboard-first, local-first Markdown notes with vim motions and live preview"
  homepage "https://github.com/ZenNotes/zennotes"

  livecheck do
    url :url
    strategy :github_latest
  end

  # The app ships its own electron auto-updater, so let it update in place
  # rather than having Homebrew flag it as outdated on every release.
  auto_updates true
  depends_on macos: :monterey

  app "ZenNotes.app"

  zap trash: [
    "~/Library/Application Support/ZenNotes",
    "~/Library/Caches/com.adibhanna.zennotes",
    "~/Library/Caches/com.adibhanna.zennotes.ShipIt",
    "~/Library/HTTPStorages/com.adibhanna.zennotes",
    "~/Library/Logs/ZenNotes",
    "~/Library/Preferences/com.adibhanna.zennotes.plist",
    "~/Library/Saved Application State/com.adibhanna.zennotes.savedState",
  ]
end
