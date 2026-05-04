VERSION := $(shell node -p "require('./manifest.json').version")
PACKAGE := dist/crunchyroll-auto-skipper-$(VERSION).zip

.PHONY: check package push

check:
	node --check content.js
	node --check service_worker.js

package: check
	mkdir -p dist
	zip -r $(PACKAGE) manifest.json service_worker.js content.js README.md LICENSE PRIVACY.md CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md docs/*.md assets/icons -x '*.DS_Store'
	@echo "Wrote $(PACKAGE)"

push:
	git add .
	git commit
	git push
