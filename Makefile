.PHONY: test

test:
	node --test --experimental-test-coverage \
		--test-coverage-include='lib/**/*.js' \
		--test-coverage-include-all \
		--test-coverage-lines=90 \
		--test-coverage-branches=90 \
		--test-coverage-exclude='test/**' \
		--test-coverage-exclude='node_modules/**' \
		test/*.test.js
