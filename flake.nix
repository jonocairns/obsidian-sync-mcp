{
  description = "Development environment for obsidian-sync-mcp";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      supportedSystems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          node22MinSource = {
            "aarch64-darwin" = {
              archive = "darwin-arm64";
              hash = "sha256-ToRctxtOiXKJMSdDsuMcQFqKSHIGVUBNgqTc4j/ENSc=";
            };
            "aarch64-linux" = {
              archive = "linux-arm64";
              hash = "sha256-CL+/U4utDoy7AmnwFzzKKNcFh0pnoi9gtX2Z3JnjAFA=";
            };
            "x86_64-darwin" = {
              archive = "darwin-x64";
              hash = "sha256-3rWyEcJfP4A81JwcP8OWTmw3JVRtfZYI2ZQnA4jcvwI=";
            };
            "x86_64-linux" = {
              archive = "linux-x64";
              hash = "sha256-abCdulyNywXE5Cc6Q0DbEAWr6v45J+/aK8WySegEN+w=";
            };
          }.${system};
          node22Min = pkgs.stdenvNoCC.mkDerivation {
            pname = "nodejs";
            version = "22.14.0";
            src = pkgs.fetchurl {
              url = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-${node22MinSource.archive}.tar.xz";
              hash = node22MinSource.hash;
            };
            nativeBuildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.autoPatchelfHook ];
            buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.stdenv.cc.cc.lib ];
            installPhase = ''
              runHook preInstall
              mkdir -p "$out"
              cp -R ./* "$out/"
              runHook postInstall
            '';
            dontFixup = pkgs.stdenv.hostPlatform.isDarwin;
          };
          mkDevShell = nodejs: pkgs.mkShell {
            packages = [
              nodejs
              pkgs.pnpm
              pkgs.docker-client
              pkgs.shellcheck
            ];
          };
        in
        {
          default = mkDevShell pkgs.nodejs_22;
          node22-min = mkDevShell node22Min;
          node24 = mkDevShell pkgs.nodejs_24;
        }
      );
    };
}
