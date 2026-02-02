{
  description = "Home Assistant Add-on Development Environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            # Container tools
            podman
            podman-compose

            # Linting tools
            hadolint      # Dockerfile linter
            shellcheck    # Shell script linter
            yamllint      # YAML linter
            actionlint    # GitHub Actions linter

            # Home Assistant development tools
            curl          # For testing endpoints
            jq            # JSON processing
            yq-go         # YAML processing

            # Build and validation tools
            git
            bash
          ];

          shellHook = ''
            echo "🏠 Home Assistant Add-on Development Environment"
            echo ""
            echo "Build Commands:"
            echo "  build-addon     - Build the Claude Terminal add-on"
            echo "  run-addon       - Run the add-on locally"
            echo "  test-endpoint   - Test add-on web endpoint"
            echo ""
            echo "Linting Commands:"
            echo "  lint-all        - Run all linters"
            echo "  lint-dockerfile - Lint the Dockerfile"
            echo "  lint-shell      - Lint all shell scripts"
            echo "  lint-yaml       - Lint YAML files"
            echo "  lint-actions    - Lint GitHub Actions workflows"
            echo ""
            echo "To get started: build-addon"

            # Build and run aliases
            alias build-addon='podman build --build-arg BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.19 -t local/claude-terminal ./claude-terminal'
            alias run-addon='podman run -p 7681:7681 -v $(pwd)/config:/config local/claude-terminal'
            alias test-endpoint='curl -X GET http://localhost:7681/ || echo "Add-on not running. Use: run-addon"'

            # Linting aliases
            alias lint-dockerfile='hadolint ./claude-terminal/Dockerfile'
            alias lint-shell='shellcheck claude-terminal/run.sh claude-terminal/scripts/*.sh'
            alias lint-yaml='yamllint -c .yamllint.yml claude-terminal/config.yaml claude-terminal/build.yaml .github/workflows/'
            alias lint-actions='actionlint'
            alias lint-all='echo "Running all linters..." && lint-dockerfile && lint-shell && lint-yaml && lint-actions && echo "✓ All linters passed!"'
          '';
        };
      });
}