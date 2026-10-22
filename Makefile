runback:
	cd backend && python manage.py runserver

db-up:
	docker compose up -d --wait postgres

db-stop:
	docker compose stop postgres

runfront:
	cd frontend && npm run dev

migrate:
	cd backend && python manage.py migrate

mmigrate:
	cd backend && python manage.py makemigrations

shell:
	cd backend && python manage.py shell

dbshell:
	cd backend && python manage.py dbshell

install-frontend:
	cd frontend && npm install

build-frontend:
	cd frontend && npm run build

runner-images:
	TMPDIR=/tmp podman pull docker.io/library/python:3.12-alpine
	TMPDIR=/tmp podman pull docker.io/library/gcc:14

runner-images-check:
	podman image exists docker.io/library/python:3.12-alpine
	podman image exists docker.io/library/gcc:14
	podman info --format 'rootless={{.Host.Security.Rootless}} graphroot={{.Store.GraphRoot}}'

up:
	python3 scripts/runner-service.py start-if-enabled
	docker compose up --build -d

stop:
	docker compose stop
	python3 scripts/runner-service.py stop

logs:
	docker compose logs -f backend frontend

docker-migrate:
	docker compose run --rm migrate

.PHONY: runner-setup runner-check runner-start runner-stop runner-status runner-enable
runner-setup:
	python3 scripts/runner-service.py setup

runner-check:
	python3 scripts/runner-service.py check

runner-start:
	python3 scripts/runner-service.py start

runner-stop:
	python3 scripts/runner-service.py stop

runner-status:
	python3 scripts/runner-service.py status

runner-enable:
	python3 scripts/runner-service.py enable

.PHONY: runner-test
runner-test:
	docker compose exec -T backend python -m workspace.worker_smoke
