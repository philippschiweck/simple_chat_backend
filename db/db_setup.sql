/*Drop existing tables*/
DROP TABLE user;

/*Create tables needed*/
CREATE TABLE user (
  id int NOT NULL auto_increment,
  name VARCHAR(50) NOT NULL,
  password VARCHAR(250) NOT NULL,
  color VARCHAR(250),
  language VARCHAR(250) NOT NULL,
  PRIMARY KEY (id)
);

/*Insert test data*/
INSERT INTO user (name, password, color, language)
VALUES ('Test', 'abcd1234', '#aeab1a', 'English');
INSERT INTO user (name, password, color, language)
VALUES ('Philipp', 'Test1234', '#ffab1a', 'German');