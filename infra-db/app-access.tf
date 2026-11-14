# --- What the web app needs to connect to the database ------------------------
# At service start, the web server looks up this instance's endpoint and reads
# the master secret, then hands DATABASE_URL to the app container (see
# ../infra/user_data.sh.tftpl, chatbot-db-env). Only this DB and this secret.
#
# Kept separate from the migrations policy so the app does not depend on it.

data "aws_iam_policy_document" "web_app_db" {
  statement {
    sid       = "DescribeThisDb"
    actions   = ["rds:DescribeDBInstances"]
    resources = [aws_db_instance.main.arn]
  }

  statement {
    sid       = "ReadDbMasterSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.main.master_user_secret[0].secret_arn]
  }
}

resource "aws_iam_role_policy" "web_app_db" {
  name   = "${local.prefix}-app-db"
  role   = data.aws_iam_role.web.name
  policy = data.aws_iam_policy_document.web_app_db.json
}
