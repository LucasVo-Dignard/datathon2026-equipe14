# CLAUDE.md

## AWS security rules (mandatory)

These rules come from the datathon organizers. Never break them, even if a task
seems to require it. If a request conflicts with them, stop and ask.

1. **NE CRÉEZ PAS de bucket S3 sans restriction d'accès.** Gardez S3 Block
   Public Access activé, ce qui est le réglage par défaut.
   - Never disable Block Public Access, add public bucket policies or ACLs, or
     enable static website hosting on a bucket.
2. **NE CRÉEZ PAS d'instance EC2 avec un groupe de sécurité ouvert à Internet.**
   - No inbound rule with `0.0.0.0/0` or `::/0`, on any port.
   - Inbound traffic is allowed only from an explicit IP allowlist
     (`/32` addresses for our own machines).
   - Outbound `0.0.0.0/0` is fine, since it doesn't allow anything in.
3. **NE CRÉEZ PAS d'instance RDS ni de cluster EMR avec l'accès public activé.**
   - `publicly_accessible = false` for RDS. Keep EMR in private subnets with
     no public master node.
4. **NE METTEZ PAS d'identifiants AWS dans un dépôt Git.** Si une clé d'accès se
   retrouve sur GitHub, considérez qu'elle est compromise en quelques minutes.
   - Credentials live only in `.env-aws` (gitignored by `.env*`). Never print
     their values, copy them into other files, or hardcode them in code or
     Terraform.
   - Also never commit `*.tfstate`, `*.tfvars` or `*.pem`. The Terraform state
     contains the generated SSH private key. It is stored only in the private
     S3 state bucket (see `infra/backend.tf`).
   - Before any commit, check that `git status` and the diff contain no secrets.
5. **LIMITEZ les ressources que vous lancez à ce dont votre projet a vraiment
   besoin, et arrêtez tout ce que vous n'utilisez pas.**
   - Use the smallest instance or disk sizes that work (default `t3.micro`,
     8 GiB). Skip extras that cost money while idle, such as Elastic IPs and
     NAT gateways, unless we actually need them.
   - Stop idle instances (`instance_running = false`) or `terraform destroy`.

Always ask before `terraform apply`, `terraform destroy`, or any command that
creates or deletes AWS resources.

## Using AWS from this repo

- Load credentials in Git Bash: `set -a; source .env-aws; set +a`
  (temporary session token: reload when it expires).
- Region: `us-east-1`.
- Infrastructure is in `infra/` (Terraform). See `infra/README.md`.
- Terraform state: S3 bucket `datathon2026-equipe14-tfstate-779846826297`
  (created by `infra/bootstrap-state-bucket.sh`, not by Terraform, so
  `terraform destroy` does not delete it).
