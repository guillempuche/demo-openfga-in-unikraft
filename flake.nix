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
        kraftkit = unikraft-nur.packages.${system}.kraftkit;
        oldPkgs =
          import (pkgs.fetchFromGitHub {
            owner = "NixOS";
            repo = "nixpkgs";
            rev = "1bb16e1d19968ac62e8cdf0ffaf2fa070f701b24";
            sha256 = "1qgbm1iz2gps1alnacpv48kksq5ypz2f6av984h2cdzm21jq712f";
          }) { inherit system; };
        openfga-cli = oldPkgs.openfga-cli; # TODO: drop pin once https://github.com/openfga/action-openfga-test/issues/32 is fixed in nixpkgs.
      in
      {
          devShells.default = pkgs.mkShell {
         buildInputs = [
            pkgs.git
            pkgs.gh
							openfga-cli # OpenFGA CLI (pinned to v0.7.5)
            kraftkit
            pkgs.starship # shell beautifier
            pkgs.zsh # ensure zsh is available for nix develop -c zsh
          ];


          shellHook = ''
            echo ""
            echo "🚀 Demo Authorization with OpenFGA hosted on Unikraft"
            echo "OpenFGA $(fga --version)"
            echo "Unikraft $(kraft version)"
            echo ""
          '';
        };
      });
}
