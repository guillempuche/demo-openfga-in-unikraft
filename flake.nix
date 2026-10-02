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
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.git
            pkgs.openfga-cli
            unikraft-cli
            pkgs.jq
            pkgs.nodejs_24 # demo API (runs .ts natively)
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
