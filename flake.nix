{
  description = "Hyperion-RAIN Wayland shader overlay and GTK4 control panel";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          hyperion-rain = pkgs.callPackage ./nix/package.nix { };
        in
        {
          inherit hyperion-rain;
          default = hyperion-rain;
        });

      apps = forAllSystems (system: {
        default = self.apps.${system}.hyperion-rain;
        hyperion-rain = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/hyperion-rain";
          meta.description = "Open the Hyperion-RAIN control panel";
        };
        gl-overlay = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/gl-overlay";
          meta.description = "Run or control the Wayland shader overlay";
        };
      });

      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            inputsFrom = [ self.packages.${system}.default ];
          };
        });

      checks = forAllSystems (system: {
        package = self.packages.${system}.default;
      });
    };
}
