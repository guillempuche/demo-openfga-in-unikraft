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
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.git
            pkgs.openfga-cli
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
