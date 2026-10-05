{
  description = "Demo Authorization with OpenFGA hosted on Unikraft";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    unikraft-nur.url = "github:unikraft/nur";
    unikraft-nur.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, flake-utils, unikraft-nur }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        unikraft-cli = unikraft-nur.packages.${system}.unikraft-cli;

        # fga CLI pinned to the release whose embedded OpenFGA matches the
        # deployed server (see versions.env; scripts/check-versions.sh checks
        # this version). nixpkgs' openfga-cli lags behind, and `fga model test`
        # runs that embedded engine.
        fgaVersion = "0.8.1";
        fgaRelease = {
          x86_64-linux = { asset = "linux_amd64"; sha256 = "e0414ad70850f8070540ad1be7a1e2e861edd6d6e73f6ed2b959c3277f98a54c"; };
          aarch64-linux = { asset = "linux_arm64"; sha256 = "6c530a0e50449b611b98f9cf66d6e33cf6533535c7f4b1055fdf0cd299d089d0"; };
          x86_64-darwin = { asset = "darwin_amd64"; sha256 = "be25a6de94d1b57289ecd66e496e97a2c6f5376adfca993bdd1e5a43231197f3"; };
          aarch64-darwin = { asset = "darwin_arm64"; sha256 = "74de011e906ca0a03058be82664069793d15dc41abe0f0780dfba5df340c947e"; };
        }.${system};
        fga = pkgs.stdenvNoCC.mkDerivation {
          pname = "openfga-cli";
          version = fgaVersion;
          src = pkgs.fetchurl {
            url = "https://github.com/openfga/cli/releases/download/v${fgaVersion}/fga_${fgaVersion}_${fgaRelease.asset}.tar.gz";
            sha256 = fgaRelease.sha256;
          };
          sourceRoot = ".";
          installPhase = "install -Dm755 fga $out/bin/fga";
        };
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.git
            fga
            unikraft-cli
            pkgs.jq
            pkgs.nodejs_24 # demo API (runs .ts natively)
            pkgs.python3 # coverage gates (scripts/check-*-coverage.py)
            pkgs.shellcheck # CI lints scripts/ with it
            pkgs.grpcurl # integration suite: gRPC-only UpdateStore
            pkgs.starship # shell beautifier
            pkgs.zsh # ensure zsh is available for nix develop -c zsh
          ];

          shellHook = ''
            echo ""
            echo "🚀 Demo Authorization with OpenFGA hosted on Unikraft"
            echo "OpenFGA $(fga --version)"
            echo "Unikraft CLI $(unikraft version 2>/dev/null | awk '/version:/{print $2}')"
            echo ""
          '';
        };
      });
}
